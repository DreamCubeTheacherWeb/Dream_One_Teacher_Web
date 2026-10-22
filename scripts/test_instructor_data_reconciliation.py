import ast
import csv
import datetime
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.instructor_data_reconciliation import (
    FinancialInstitution,
    compose_bio,
    derive_gender,
    map_management_level,
    parse_legacy_bank_info,
    parse_regions,
    reconcile_instructor,
    resolve_employment_and_personnel,
    write_private_json,
)

SCRIPTS_DIR = Path(__file__).resolve().parent


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


class ManagementLevelMappingTest(unittest.TestCase):
    """舊表單「管理層級」→ 合作狀態 employment_status＋人員類別 personnel_types（2026-10-22 起）。"""

    EXPECTED = {
        "老師": ("active", ["instructor"]),
        "職員": ("active", ["staff"]),
        "工讀生": ("active", ["part_time"]),
        "助教": ("active", ["instructor"]),
        "冷凍": ("frozen", ["instructor"]),
        "取消合作": ("cancelled", ["instructor"]),
    }

    def test_maps_each_management_level(self):
        for raw, expected in self.EXPECTED.items():
            self.assertEqual(map_management_level(raw), expected, raw)
        self.assertEqual(map_management_level(" 職員 "), ("active", ["staff"]))

    def test_blank_or_unknown_becomes_none_status_with_instructor_type(self):
        for raw in (None, "", "   ", "不明", "取消合作(手動標註)", "assistant", "part_time"):
            self.assertEqual(map_management_level(raw), (None, ["instructor"]), repr(raw))

    def test_returned_list_is_a_copy(self):
        _, types = map_management_level("職員")
        types.append("instructor")
        self.assertEqual(map_management_level("職員"), ("active", ["staff"]))

    def test_import_prefers_precomputed_types_and_recomputes_for_old_preview_json(self):
        new_style = {"employment_status": "frozen", "personnel_types": ["instructor"], "employment_status_raw": "冷凍"}
        self.assertEqual(resolve_employment_and_personnel(new_style), ("frozen", ["instructor"]))
        old_style = {"employment_status": "staff", "employment_status_raw": "職員"}
        self.assertEqual(resolve_employment_and_personnel(old_style), ("active", ["staff"]))
        old_part_time = {"employment_status": "part_time", "employment_status_raw": "工讀生"}
        self.assertEqual(resolve_employment_and_personnel(old_part_time), ("active", ["part_time"]))
        self.assertEqual(
            resolve_employment_and_personnel({"employment_status": None, "employment_status_raw": None}),
            (None, ["instructor"]),
        )

    def test_merge_script_writes_new_fields_for_every_level(self):
        """在暫存資料夾用假 CSV 實跑 merge_instructors.py（不碰任何資料庫），檢查預覽 JSON。"""
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "scripts").mkdir()
            for name in ("merge_instructors.py", "instructor_data_reconciliation.py"):
                shutil.copy(SCRIPTS_DIR / name, base / "scripts" / name)
            teacher_rows = [
                {"姓名": "甲老師", "管理層級": "老師", "老師等級": "A"},
                {"姓名": "乙職員", "管理層級": "職員", "老師等級": ""},
                {"姓名": "丙工讀", "管理層級": "工讀生", "老師等級": ""},
                {"姓名": "丁助教", "管理層級": "助教", "老師等級": "B"},
                {"姓名": "戊冷凍", "管理層級": "冷凍", "老師等級": "A"},
                {"姓名": "己取消", "管理層級": "取消合作", "老師等級": "B"},
                {"姓名": "庚空白", "管理層級": "", "老師等級": ""},
                {"姓名": "辛未知", "管理層級": "實習夥伴", "老師等級": ""},
                {"姓名": "洪紹恆", "管理層級": "老師", "老師等級": "A"},
            ]
            with open(base / "講師 資料總表 23年啟用永久版 - 老師資料表.csv", "w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=["姓名", "管理層級", "老師等級"])
                writer.writeheader()
                writer.writerows(teacher_rows)
            with open(base / "講師 資料總表 23年啟用永久版 - 表單回應 1.csv", "w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=["姓名", "講師身分"])
                writer.writeheader()
                writer.writerow({"姓名": "壬表單", "講師身分": "A"})  # 只有表單回應的人
            result = subprocess.run(
                [sys.executable, str(base / "scripts" / "merge_instructors.py")],
                cwd=base, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr[-500:])
            merged = {r["full_name"]: r for r in json.loads(
                (base / "scripts" / "instructors_merged_preview.json").read_text(encoding="utf-8")
            )}
        got = {name: (r["employment_status"], r["personnel_types"], r["employment_status_raw"]) for name, r in merged.items()}
        self.assertEqual(got, {
            "甲老師": ("active", ["instructor"], "老師"),
            "乙職員": ("active", ["staff"], "職員"),
            "丙工讀": ("active", ["part_time"], "工讀生"),
            "丁助教": ("active", ["instructor"], "助教"),  # 原字串照舊保留在 employment_status_raw
            "戊冷凍": ("frozen", ["instructor"], "冷凍"),
            "己取消": ("cancelled", ["instructor"], "取消合作"),
            "庚空白": (None, ["instructor"], None),
            "辛未知": (None, ["instructor"], "實習夥伴"),
            "洪紹恆": ("cancelled", ["instructor"], "取消合作(手動標註)"),  # 手動覆寫個案
            "壬表單": (None, ["instructor"], None),
        })

    def test_import_to_row_sends_personnel_types_array_and_treats_it_as_authoritative(self):
        source = (SCRIPTS_DIR / "import_instructors.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        wanted_assigns = {"TW_COUNTIES", "REGION_ALIAS"}
        wanted_functions = {"parse_regions", "parse_date", "parse_timestamp", "to_row"}
        nodes = [
            node for node in tree.body
            if (isinstance(node, ast.FunctionDef) and node.name in wanted_functions)
            or (isinstance(node, ast.Assign) and any(getattr(t, "id", None) in wanted_assigns for t in node.targets))
        ]
        self.assertEqual({n.name for n in nodes if isinstance(n, ast.FunctionDef)}, wanted_functions)
        namespace = {
            "re": re, "datetime": datetime,
            "compose_bio": compose_bio, "derive_gender": derive_gender,
            "parse_legacy_bank_info": parse_legacy_bank_info,
            "resolve_employment_and_personnel": resolve_employment_and_personnel,
            "FINANCIAL_INSTITUTIONS": {},
        }
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "import_instructors.py", "exec"), namespace)  # noqa: S102
        to_row = namespace["to_row"]

        staff = to_row({"full_name": "乙職員", "employment_status": "staff", "employment_status_raw": "職員"})  # 舊預覽 JSON
        self.assertEqual((staff["employment_status"], staff["personnel_types"]), ("active", ["staff"]))
        part_time = to_row({"full_name": "丙工讀", "employment_status": "active", "personnel_types": ["part_time"], "employment_status_raw": "工讀生"})
        self.assertEqual((part_time["employment_status"], part_time["personnel_types"]), ("active", ["part_time"]))
        blank = to_row({"full_name": "庚空白", "employment_status": None, "personnel_types": ["instructor"], "employment_status_raw": None})
        self.assertNotIn("employment_status", blank)  # None 不寫入，資料庫維持 NULL（視為合作中）
        self.assertEqual(blank["personnel_types"], ["instructor"])
        self.assertTrue(re.search(r'authoritative_fields = \{[^}]*"personnel_types"', source), "人員類別要和合作狀態一樣以匯入表為準")


if __name__ == "__main__":
    unittest.main()
