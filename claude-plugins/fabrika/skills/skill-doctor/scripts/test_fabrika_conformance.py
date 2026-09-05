#!/usr/bin/env python3
"""Fabrika packaging conformance for the vendored skill-doctor (#8048).

Doc-level conformance only. These tests assert that the shipped SKILL.md and
contract.md carry this child's required contracts — session scoping, the scoring
contract, failed-conversation-only edit gating, section addressability, and the
documented collector/discovery limitations. They prove the documentation exists
where the skill reads it; they prove nothing about the runtime behavior of the
upstream scripts. Upstream's own suites, run against upstream's own SKILL.md in
the separate baseline target, cover that code.

Fabrika-authored (editable) — see PROVENANCE.md.
"""

import re
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
SKILL = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
CONTRACT = (SKILL_ROOT / "contract.md").read_text(encoding="utf-8")

RESULTS_DIR = "claude-plugins/fabrika/skills/skill-doctor/results"


def bash_fences(text):
    """Every fenced bash block in the skill body — the §4 literal-rule surface."""
    return re.findall(r"```bash\n(.*?)```", text, re.S)


class SessionScoping(unittest.TestCase):
    """The collector must be scoped to fabrika's corpus and the gitignored results dir."""

    def test_collect_command_pins_fabrika_corpus(self):
        self.assertIn("--skills-dir claude-plugins/fabrika/skills", SKILL)
        self.assertIn("--repo .", SKILL)

    def test_collect_outputs_are_documented_under_the_results_dir(self):
        # Doc-level check only: the command's documented output locations are the
        # results dir. This does not prove runtime writes stay inside it.
        self.assertIn(RESULTS_DIR + "/claude-home", SKILL)
        self.assertIn(RESULTS_DIR + "/run", SKILL)

    def test_sampling_window_is_fixed(self):
        self.assertIn("--days 45", SKILL)
        self.assertIn("--max-sessions 20", SKILL)


class ScoringContract(unittest.TestCase):
    """Contract section carries the labels, verdicts, and upstream's formulas."""

    def test_efficiency_labels_carry_their_scores(self):
        self.assertIn("`highly_efficient` (1)", CONTRACT)
        self.assertIn("`mostly_efficient` (0.8)", CONTRACT)
        self.assertIn("`mostly_inefficient` (0.4)", CONTRACT)
        self.assertIn("`highly_inefficient` (0.2)", CONTRACT)

    def test_code_quality_verdicts_carry_their_scores(self):
        self.assertIn("`approve` (1)", CONTRACT)
        self.assertIn("`block` (0.2)", CONTRACT)
        self.assertIn("`insufficient_evidence` (0.5)", CONTRACT)
        self.assertIn("excluded from the code-quality mean", CONTRACT)

    def test_aggregation_formulas(self):
        self.assertIn("0.5 + 0.5 * score", CONTRACT)
        self.assertIn("0.5 * curve(raw_efficiency)", CONTRACT)
        self.assertIn("0.35 * curve(raw_code_quality)", CONTRACT)
        self.assertIn("0.15 * skill_coverage", CONTRACT)


class FailedConversationOnlyEdits(unittest.TestCase):
    """Edit drafting is gated on failed conversations and the upstream reference."""

    def test_gate_names_failed_conversations_and_the_reference(self):
        self.assertIn("failed conversation", CONTRACT)
        self.assertIn(
            "[`references/skill-improvements.md`](references/skill-improvements.md)",
            CONTRACT,
        )

    def test_failed_conversation_threshold_is_raw_below_half(self):
        self.assertIn("below 0.5 is a **failed conversation**", CONTRACT)

    def test_no_edit_is_a_recorded_success(self):
        self.assertIn("Opening no edit and saying why", CONTRACT)


class SectionAddressability(unittest.TestCase):
    """The three contract sections the SKILL.md points at exist verbatim."""

    def test_contract_sections_exist(self):
        for heading in ("## Collector flags", "## Scoring contract", "## Report artifacts"):
            self.assertIn(heading + "\n", CONTRACT)


class DocumentedLimitations(unittest.TestCase):
    """The inert-on-arrival gaps are named with their owning children."""

    def test_skill_names_the_two_arrival_gaps(self):
        self.assertIn("#8049", SKILL)
        self.assertIn("#8051", SKILL)

    def test_contract_documents_the_missing_opencode_collector(self):
        self.assertIn("opencode", CONTRACT)
        self.assertIn("#8049", CONTRACT)


class PlainLiteralCommands(unittest.TestCase):
    """Conventions §4: bash fences carry no expansion and no `..` climb."""

    def test_bash_fences_are_plain_literals(self):
        fences = bash_fences(SKILL)
        self.assertTrue(fences, "the skill body must still carry its bash commands")
        for fence in fences:
            self.assertNotIn("$", fence)
            self.assertNotIn("..", fence)


if __name__ == "__main__":
    unittest.main()
