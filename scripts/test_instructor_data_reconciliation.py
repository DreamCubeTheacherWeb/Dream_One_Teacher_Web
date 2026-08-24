import tempfile
import unittest
from pathlib import Path

from scripts.instructor_data_reconciliation import (
    FinancialInstitution,
    compose_bio,
    derive_gender,
    parse_legacy_bank_info,
    parse_regions,
    reconcile_instructor,
    write_private_json,
)


class InstructorDataReconciliationTest(unittest.TestCase):
    def setUp(self):
        self.institutions = {
            "0087007": FinancialInstitution("0087007", "華南商業銀行", "高雄分行")
        }

    def test_derives_only_valid_taiwan_id_gender_marker(self):
        self.assertEqual(derive_gender("A123456789"), "男")
        self.assertEqual(derive_gender("B223456789"), "女")
        self.assertIsNone(derive_gender("not-an-id"))

    def test_parses_regions_and_aliases_without_duplicates(self):
        self.assertEqual(parse_regions("雙北、台中市、臺北市"), ["臺北市", "新北市", "臺中市"])

    def test_composes_legacy_bio_fields(self):
        self.assertEqual(
            compose_bio({"bio_teaching_experience": "營隊教學", "teaching_philosophy": "鼓勵探索"}),
            "【授課經驗】營隊教學\n【教學理念】鼓勵探索",
        )

    def test_parses_only_high_confidence_bank_rows(self):
        parsed = parse_legacy_bank_info("0087007／123-456-789／王小明", "王小明", self.institutions)
        self.assertEqual(parsed, {
            "bank_account_name": "王小明",
            "bank_name": "華南商業銀行",
            "bank_branch": "高雄分行",
            "bank_account_number": "123456789",
            "bank_code": "0087007",
        })
        self.assertIsNone(
            parse_legacy_bank_info("0087007／123456789／不同戶名", "王小明", self.institutions)
        )
        self.assertIsNone(
            parse_legacy_bank_info("008／123456789／王小明", "王小明", self.institutions)
        )

    def test_reconcile_fills_missing_values_but_preserves_existing_values(self):
        instructor = {
            "id": "row-1",
            "updated_at": "2026-08-24T00:00:00Z",
            "full_name": "王小明",
            "nickname": None,
            "gender": None,
            "id_number": "A123456789",
            "line_name": "既有 Line 名稱",
            "line_id": "existing-line-id",
            "address": None,
            "household_address": None,
            "bio_notes": None,
            "bio_teaching_experience": "既有經驗",
            "teaching_regions": None,
            "teaching_regions_raw": "台中",
            "bank_info_raw": "0087007/123456789/王小明",
        }
        form = {
            "Line ID": "must-not-overwrite",
            "戶籍地址": "戶籍來源",
            "通訊地址": "通訊來源",
        }
        patch = reconcile_instructor(instructor, form, None, self.institutions)

        self.assertEqual(patch["changes"]["nickname"], "既有 Line 名稱")
        self.assertEqual(patch["changes"]["gender"], "男")
        self.assertEqual(patch["changes"]["household_address"], "戶籍來源")
        self.assertEqual(patch["changes"]["address"], "通訊來源")
        self.assertEqual(patch["changes"]["teaching_regions"], ["臺中市"])
        self.assertNotIn("line_id", patch["changes"])
        self.assertEqual(patch["changes"]["bank_branch"], "高雄分行")

    def test_corrects_only_the_known_historical_address_swap_shape(self):
        instructor = {
            "id": "row-2",
            "full_name": "王小明",
            "address": "戶籍來源",
            "household_address": None,
            "bio_notes": "[通訊地址] 通訊來源",
        }
        teacher = {"戶籍地址": "戶籍來源", "通訊地址": "通訊來源"}
        patch = reconcile_instructor(instructor, None, teacher, self.institutions)
        self.assertEqual(patch["changes"]["household_address"], "戶籍來源")
        self.assertEqual(patch["changes"]["address"], "通訊來源")

        changed_by_user = {**instructor, "address": "本人更新地址"}
        preserved = reconcile_instructor(changed_by_user, None, teacher, self.institutions)
        self.assertNotIn("address", preserved["changes"])

    def test_private_patch_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "patch.json"
            write_private_json(path, [{"id": "row-1"}])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
