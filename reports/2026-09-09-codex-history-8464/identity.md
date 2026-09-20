# Build and evidence identity

Reference companion to the [report](../2026-09-09-codex-history-8464.md).

## Public package comparison

Fetched the [release metadata](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4)
and [macOS arm64 archive](https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-aarch64-apple-darwin.tar.gz) into isolated scratch.
The archive was not installed or executed. `tar -xOzf` streamed its sole member
`codex-aarch64-apple-darwin` to `shasum -a 256`. That hash exactly equaled
the installed executable's hash.

```json
{
  "releaseId": 383061770,
  "tag": "rust-v0.153.4",
  "publishedAt": "2026-09-04T23:25:48Z",
  "asset": {
    "name": "codex-aarch64-apple-darwin.tar.gz",
    "size": 87323149,
    "githubDigest": "sha256:8cf911ea676523bfb2121ec561848d2aba564890ad536db4d8a3353f2b9850b1",
    "observedArchiveSha256": "8cf911ea676523bfb2121ec561848d2aba564890ad536db4d8a3353f2b9850b1"
  },
  "installedAndPublicExecutableSha256": "b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3",
  "platform": "Mach-O arm64; Mac OS 14.3.1",
  "tagObject": "042fb41b7c813ac7999105e886b2b7aa715b5081",
  "sourceCommit": "3d2ee51ca2d5db578f328aa75e20aa22c0197c9a"
}
```

The [annotated tag object](https://api.github.com/repos/openai/codex/git/tags/042fb41b7c813ac7999105e886b2b7aa715b5081)
points to that commit. Source was freshly fetched from the tag archive and raw source URLs,
not copied from unversioned main. The public release tag is unsigned; this comparison proves
byte identity to GitHub's published package, not a signed/reproducible-build attestation.

## Old references rechecked

The old temporary README equals freshly fetched versioned README byte-for-byte:
`1142bff07746d3b54dccf39fd84b58798ae609cd73fa26c82fa07743abc0395a`.
The five old request types equal fresh
`codex app-server generate-ts --experimental --out <allocated-output>` results byte-for-byte.
Without `--experimental`, ThreadStartParams omits historyMode and has a different hash;
that default schema comparison was not silently called a match.

```json
[
  {
    "name": "ThreadStartParams",
    "sha256": "7a3fddbb0cf0585c52edbf19e3a1f6e691681f18ab509f7abfa416da7f0ac824"
  },
  {
    "name": "ThreadReadParams",
    "sha256": "c24743cb5655b4c71a853a2a290412d78e1a27e0278f2a0cde9bd9d9b78118a8"
  },
  {
    "name": "ThreadResumeParams",
    "sha256": "e4f64c88205dbba2bf87635d12b9c5803dd6f19b84b5682a71df7fdcf87862fb"
  },
  {
    "name": "ThreadTurnsListParams",
    "sha256": "ff03522c5cd95e5dd0b03a6d918bf7c2453b491fb47b8109420d52fe9df619b3"
  },
  {
    "name": "ThreadItemsListParams",
    "sha256": "14900f931749e2e8c1b4f065a53dd978bc1088ac8f0decf247b3d46078f7185d"
  }
]
```

## Trace and fixture digests

Original fixture digests include each run's real allocated cwd. Portable digests use the exact
recorded fixture lines with `$ROOT` and a newline after every JSONL record. The legacy fixture
has 13 records; each paginated fixture has 15 with contiguous ordinals 0–14. These are
pre-resume fixtures; subsequent Codex resume can append its own bookkeeping records.

```json
[
  {
    "name": "default-first",
    "requests": 224,
    "raw": "0d3700d0362b80a11312167206e7aaf6821abb5d234ddf3fbd4f9455461614d0",
    "published": "ba486539f1a61ac300a40127f575326a2d06176e6b3aac5d8a74a6e535613ed7",
    "fixtures": [
      {
        "mode": "default",
        "persistedMode": "paginated",
        "originalSha256": "3ac0cde2e74ac4a40f084cb1930eda61ea5cba2716cc9bbf958f5a459321affd",
        "portableSha256": "1b582452ed6547d0a0625dd4660b6ca4a076c6e402ab6b7e6e120f3f4d899566",
        "lineCount": 15
      },
      {
        "mode": "legacy",
        "persistedMode": "legacy",
        "originalSha256": "35efc5c0d78d46b9355cef2aaa4853b5d4abcc019eb106a11ed91f43c3d8f651",
        "portableSha256": "9c1b5fef1ea1eec06d5b78c588a023f6c50299dc5fdf0d629a1139db41c10214",
        "lineCount": 13
      },
      {
        "mode": "paginated",
        "persistedMode": "paginated",
        "originalSha256": "19074484a1924be13e74548ea5bf82038334e5bf6c7817efff63ea1b659c7523",
        "portableSha256": "02c19d2dfc679c0bf643f2c2032998eb064d32bb18b8fef3637f8eb39ff800b1",
        "lineCount": 15
      }
    ]
  },
  {
    "name": "legacy-first",
    "requests": 224,
    "raw": "a1de3c333bc447c82dc2592e9d586f1b8247ef2eeecea9e7bc5da5b514d733dd",
    "published": "b252fc226e219542980f3ab683bee788f1a9d6c3c40938630cd7393221b6c66b",
    "fixtures": [
      {
        "mode": "default",
        "persistedMode": "paginated",
        "originalSha256": "7a72dc8f76535bae8af2453a8c537fe9b61eccb7a6509d161c0ad501978c4c77",
        "portableSha256": "1b582452ed6547d0a0625dd4660b6ca4a076c6e402ab6b7e6e120f3f4d899566",
        "lineCount": 15
      },
      {
        "mode": "legacy",
        "persistedMode": "legacy",
        "originalSha256": "fcca7e605d293fcb91f0672c430670feb24752c7321cffb61d8d4b250709d466",
        "portableSha256": "9c1b5fef1ea1eec06d5b78c588a023f6c50299dc5fdf0d629a1139db41c10214",
        "lineCount": 13
      },
      {
        "mode": "paginated",
        "persistedMode": "paginated",
        "originalSha256": "cd15d77d447490a877e9c148c1eced6d200685679509e3609e4614247b399b7d",
        "portableSha256": "02c19d2dfc679c0bf643f2c2032998eb064d32bb18b8fef3637f8eb39ff800b1",
        "lineCount": 15
      }
    ]
  },
  {
    "name": "builtin-initial",
    "requests": 66,
    "raw": "028e8d7f58952b87ff75a3a24772d47b9ea1b8979d73e1e79977f98c48db65df",
    "published": "d1540b1f449b4d7c587369898808abdcc54cf659da13b24f7f65f9f0596ff919",
    "fixtures": []
  }
]
```
