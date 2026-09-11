#!/usr/bin/env python3
"""DISCOVERY-ONLY ADAPTER (PoC-local, NOT part of the imported skill).

phoenix PoC: benchmarks/warp-skill-doctor-import-poc.

The upstream Warp Skill Doctor (imported byte-exact at
claude-plugins/fabrika/skills/skill-doctor/) has collectors for Claude Code
project JSONL, Codex rollout JSONL, and Warp SQLite -- but NOT for opencode,
the harness this repository actually runs under. The only real phoenix-local
agent conversations on this machine live in opencode's SQLite store.

This adapter translates real opencode sessions (read-only, from
~/.local/share/opencode/opencode.db) into Claude-Code-shaped project-history
JSONL under a temporary claude-home, so that the UNMODIFIED upstream
collect_sessions.py --claude-home parser can collect them with its real
Claude Code code path. Everything downstream -- sampling, stats, transcript
condensing, rubrics, scoring, aggregation, report rendering -- is the
upstream pipeline's.

It is a translation shim for one unsupported conversation source. It does
not score, judge, or aggregate anything, and it never leaves this machine.

Mapping (opencode -> Claude Code shape, as consumed by parse_claude_session):
  message(role=user, part text)      -> type=user message.content text
  message(role=assistant, text part) -> type=assistant message.content text
  part type=tool                     -> tool_use {name, input}
                                        (tool result content attached from the
                                        same part's state.output)
  part type=patch                    -> an Edit tool_use marker (file names)
                                        so upstream's has_code_edits fires
Shared fields per record: sessionId, cwd, timestamp (ISO), version.
"""

import json
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

OPENCODE_DB = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
# opencode's session directory rows use forward slashes regardless of OS.
PHOENIX_DIR = str(Path.cwd()).replace("\\", "/")
OUT_ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
MAX_SESSIONS = int(sys.argv[2]) if len(sys.argv) > 2 else 10

CODE_EDIT_TOOLS = {"write", "edit", "patch", "multiedit"}


def iso(ms):
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def main():
    if not OPENCODE_DB.is_file():
        print("error: opencode database not found", file=sys.stderr)
        sys.exit(1)
    con = sqlite3.connect(f"file:{OPENCODE_DB.as_posix()}?mode=ro", uri=True)

    sessions = list(con.execute(
        "SELECT id, directory, time_created, time_updated FROM session "
        "WHERE directory = ? AND parent_id IS NULL "
        "ORDER BY time_updated DESC LIMIT ?",
        (PHOENIX_DIR, MAX_SESSIONS),
    ))
    if not sessions:
        print("BLOCKED: no eligible opencode sessions for this checkout", file=sys.stderr)
        sys.exit(2)

    project_dir_name = PHOENIX_DIR.replace("/", "-").replace(":", "").replace("\\", "-")
    project_out = OUT_ROOT / "claude-home" / "projects" / project_dir_name
    project_out.mkdir(parents=True, exist_ok=True)

    manifest = []
    for sid, directory, created, updated in sessions:
        out_path = project_out / f"{sid}.jsonl"
        records = []
        for mid, role, mtime in con.execute(
            "SELECT id, json_extract(data, '$.role'), time_created FROM message "
            "WHERE session_id = ? ORDER BY time_created", (sid,),
        ):
            parts = list(con.execute(
                "SELECT data FROM part WHERE message_id = ? ORDER BY time_created", (mid,),
            ))
            blocks = []
            content = None
            for (pdata,) in parts:
                p = json.loads(pdata)
                ptype = p.get("type")
                if ptype == "text":
                    text = p.get("text") or ""
                    if text.strip():
                        blocks.append({"type": "text", "text": text})
                elif ptype == "tool":
                    st = p.get("state") or {}
                    tool = p.get("tool") or "unknown"
                    inp = st.get("input") if isinstance(st.get("input"), dict) else {}
                    blocks.append({
                        "type": "tool_use",
                        "name": tool,
                        "input": inp,
                        # attach output for the tool_result view upstream renders
                        "_output": st.get("output") if isinstance(st.get("output"), str) else None,
                        "_status": st.get("status"),
                    })
                elif ptype == "patch":
                    raw = p.get("files")
                    if isinstance(raw, dict):
                        names = sorted(str(k) for k in raw.keys())
                    elif isinstance(raw, list):
                        names = sorted(str(v) for v in raw)
                    else:
                        names = []
                    blocks.append({
                        "type": "tool_use",
                        "name": "Edit",
                        "input": {"file_path": names[0] if names else "unknown"},
                        "_output": f"patched files: {', '.join(names) if names else 'none'}",
                        "_status": "completed",
                    })
            if not blocks:
                continue
            # opencode tool results ride inside the same part; emit them as a
            # following tool_result user record so upstream sees outputs.
            if any(b.get("_output") is not None for b in blocks if b.get("type") == "tool_use"):
                record_blocks = []
                result_blocks = []
                for b in blocks:
                    if b.get("type") == "tool_use":
                        record_blocks.append({
                            "type": "tool_use",
                            "name": b["name"],
                            "input": b["input"],
                        })
                        if b.get("_output") is not None:
                            result_blocks.append({
                                "type": "tool_result",
                                "content": b["_output"],
                                "is_error": bool(b.get("_status") and b["_status"] != "completed"),
                            })
                    else:
                        record_blocks.append(b)
                if record_blocks:
                    records.append(make_record(sid, directory, mtime, role, record_blocks))
                if result_blocks:
                    records.append(make_record(sid, directory, mtime, "user", result_blocks))
            else:
                records.append(make_record(sid, directory, mtime, role, blocks))

        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            for r in records:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

        msg_count = len(records)
        manifest.append({
            "session_id": sid,
            "directory": directory,
            "time_created": iso(created),
            "time_updated": iso(updated),
            "records": msg_count,
            "file": str(out_path),
        })

    (OUT_ROOT / "adapter_manifest.json").write_text(
        json.dumps(
            {
                "source": str(OPENCODE_DB),
                "harness": "opencode",
                "adapter": "discovery-only translation to Claude-Code-shaped JSONL; "
                          "upstream collector parses these files unmodified",
                "sessions": manifest,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"adapted {len(manifest)} opencode session(s) -> {project_out}")
    for m in manifest:
        print(f"  {m['session_id']} ({m['records']} records, updated {m['time_updated']})")
    con.close()


def make_record(session_id, cwd, mtime, role, blocks):
    return {
        "sessionId": session_id,
        "cwd": cwd,
        "timestamp": iso(mtime),
        "version": "opencode-adapter-poc",
        "type": role,
        "uuid": str(uuid.uuid4()),
        "message": {"role": role, "content": blocks},
    }


if __name__ == "__main__":
    main()
