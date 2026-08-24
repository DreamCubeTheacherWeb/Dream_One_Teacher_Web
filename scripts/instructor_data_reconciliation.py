"""Safely reconcile imported instructor profiles without overwriting newer values.

The source exports contain highly sensitive personal data. This module therefore
prints aggregate counts only. A row-level patch file is written only when the
caller explicitly supplies ``--output``; that file is created with mode 0600 and
must never be committed.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


EMPTY_VALUES = {
    "",
    "-",
    "無",
    "沒有",
    "尚未填寫",
    "#N/A",
    "早就寫了",
    "沿用",
    "沿用去年",
    "沿用去年答案",
    "同上",
}

FORM_FIELDS = {
    "birth_date": "出生年月日",
    "id_number": "身份證字號",
    "phone_mobile": "手機號碼",
    "phone_home": "家電號碼",
    "email_primary": "電子郵件",
    "email_secondary": "電子郵件地址",
    "household_address": "戶籍地址",
    "address": "通訊地址",
    "school_info": "目前就讀學校、科系、年級",
    "line_name": "Line 名字",
    "line_id": "Line ID",
    "facebook_url": "個人臉書網址 (加教師日誌社群用)",
    "bio_personal_experience": "個人經歷 ",
    "bio_teaching_experience": "授課經驗",
    "teaching_philosophy": "教學理念 ",
    "teaching_freq_semester": "(學期間) 接課頻率調查， 作答數字部分即可",
    "teaching_freq_vacation": "(寒暑期) 接課頻率調查， 作答數字部分即可",
    "teaching_regions_raw": "接課地區調查， 作答縣市即可",
    "bank_info_raw": "匯款帳戶資料 (辦華南銀行帳戶才不會每月被扣15元手續費)",
    "note_to_team": "有沒有想對夢想一號說的話",
    "id_front_external_url": "身分證正面",
    "id_back_external_url": "身分證反面 ",
    "bankbook_external_url": "存摺封面",
}

TEACHER_FIELDS = {
    "birth_date": "出生年月日",
    "id_number": "身份證字號",
    "phone_mobile": "手機號碼",
    "phone_home": "家電號碼",
    "email_primary": "信箱",
    "household_address": "戶籍地址",
    "address": "通訊地址",
    "school_info": "目前就讀學校、科系、年級",
    "teaching_regions_raw": "接課地區",
}

TW_COUNTIES = {
    "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
    "基隆市", "新竹市", "嘉義市", "新竹縣", "苗栗縣", "彰化縣",
    "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣",
    "臺東縣", "澎湖縣", "金門縣", "連江縣",
}

REGION_ALIASES = {
    "雙北": ["臺北市", "新北市"],
    "北北": ["臺北市", "新北市"],
    "台北": ["臺北市"], "臺北": ["臺北市"], "台北市": ["臺北市"],
    "新北": ["新北市"], "桃園": ["桃園市"],
    "台中": ["臺中市"], "臺中": ["臺中市"], "台中市": ["臺中市"],
    "台南": ["臺南市"], "臺南": ["臺南市"],
    "高雄": ["高雄市"], "基隆": ["基隆市"],
    "新竹": ["新竹市"], "嘉義": ["嘉義市"],
    "苗栗": ["苗栗縣"], "彰化": ["彰化縣"], "南投": ["南投縣"],
    "雲林": ["雲林縣"], "屏東": ["屏東縣"], "宜蘭": ["宜蘭縣"],
    "花蓮": ["花蓮縣"], "台東": ["臺東縣"], "臺東": ["臺東縣"],
    "澎湖": ["澎湖縣"], "金門": ["金門縣"], "連江": ["連江縣"],
    "員林市": ["彰化縣"], "竹北市": ["新竹縣"],
}

REQUIRED_FIELDS = (
    "full_name", "nickname", "gender", "birth_date", "id_number",
    "phone_mobile", "line_id", "address", "household_address",
    "email_primary", "teaching_freq_semester", "teaching_freq_vacation",
    "bio_notes", "bank_account_name", "bank_name", "bank_branch",
    "bank_account_number", "bank_code",
)


def clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return None if text in EMPTY_VALUES else text


def has_value(value: Any) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def normalize_email(value: Any) -> str:
    return (clean(value) or "").casefold()


def normalize_name(value: Any) -> str:
    return re.sub(r"\s+", "", clean(value) or "")


def parse_date(value: Any) -> str | None:
    raw = clean(value)
    if not raw:
        return None
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def derive_gender(id_number: Any) -> str | None:
    normalized = (clean(id_number) or "").upper()
    if not re.fullmatch(r"[A-Z][12]\d{8}", normalized):
        return None
    return "男" if normalized[1] == "1" else "女"


def parse_regions(raw: Any) -> list[str] | None:
    value = clean(raw)
    if not value:
        return None
    result: list[str] = []
    seen: set[str] = set()
    tokens = re.split(r"[,，、/／\s]+", value)
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        normalized = token.replace("台", "臺")
        candidates: Iterable[str] = ()
        if normalized in TW_COUNTIES:
            candidates = (normalized,)
        elif token in REGION_ALIASES:
            candidates = REGION_ALIASES[token]
        elif normalized in REGION_ALIASES:
            candidates = REGION_ALIASES[normalized]
        for county in candidates:
            if county not in seen:
                seen.add(county)
                result.append(county)
    return result or None


def compose_bio(record: dict[str, Any]) -> str | None:
    sections = (
        ("個人經歷", record.get("bio_personal_experience")),
        ("授課經驗", record.get("bio_teaching_experience")),
        ("教學理念", record.get("teaching_philosophy")),
    )
    parts = [f"【{label}】{clean(value)}" for label, value in sections if clean(value)]
    return "\n".join(parts) or None


def _remove_corporate_suffix(name: str) -> str:
    for suffix in ("股份有限公司", "有限責任", "有限公司"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


@dataclass(frozen=True)
class FinancialInstitution:
    code: str
    bank_name: str
    branch_name: str


def load_financial_institutions(path: Path) -> dict[str, FinancialInstitution]:
    with path.open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))

    roots: dict[str, str] = {}
    for row in rows:
        total_code = clean(row.get("總機構代號"))
        institution_code = clean(row.get("機構代號"))
        institution_name = clean(row.get("機構名稱"))
        if total_code and not institution_code and institution_name:
            roots[total_code] = _remove_corporate_suffix(institution_name)

    result: dict[str, FinancialInstitution] = {}
    for row in rows:
        code = clean(row.get("機構代號"))
        full_name = clean(row.get("機構名稱"))
        total_code = clean(row.get("總機構代號"))
        if not code or not re.fullmatch(r"\d{7}", code) or not full_name or not total_code:
            continue
        bank_name = roots.get(total_code)
        if not bank_name or not full_name.startswith(bank_name):
            continue
        branch_name = full_name[len(bank_name):].strip() or "總行"
        result[code] = FinancialInstitution(code, bank_name, branch_name)
    return result


def parse_legacy_bank_info(
    raw: Any,
    full_name: Any,
    institutions: dict[str, FinancialInstitution],
) -> dict[str, str] | None:
    """Parse only unambiguous ``7-digit code / account / account holder`` rows."""
    value = clean(raw)
    holder_name = normalize_name(full_name)
    if not value or not holder_name:
        return None

    parts = [part.strip() for part in re.split(r"[／/\n,，]+", value) if part.strip()]
    code_matches = []
    for part in parts[:2]:
        code_matches.extend(
            match for match in re.findall(r"(?<!\d)(\d{7})(?!\d)", part)
            if match in institutions
        )
    code_matches = list(dict.fromkeys(code_matches))
    if len(code_matches) != 1:
        return None
    code = code_matches[0]

    account_candidates = []
    for part in parts:
        digits = re.sub(r"\D", "", part)
        if 7 <= len(digits) <= 16 and digits != code:
            account_candidates.append(digits)
    account_candidates = list(dict.fromkeys(account_candidates))
    if len(account_candidates) != 1:
        return None

    if not any(normalize_name(part) == holder_name for part in parts[1:]):
        return None

    institution = institutions[code]
    return {
        "bank_account_name": clean(full_name) or "",
        "bank_name": institution.bank_name,
        "bank_branch": institution.branch_name,
        "bank_account_number": account_candidates[0],
        "bank_code": code,
    }


def load_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def load_production_export(path: Path) -> list[dict[str, Any]]:
    csv.field_size_limit(sys.maxsize)
    with path.open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))
    if len(rows) != 1 or "instructors_export" not in rows[0]:
        raise ValueError("production export must contain one instructors_export JSON cell")
    payload = json.loads(rows[0]["instructors_export"])
    if not isinstance(payload, list):
        raise ValueError("instructors_export must be a JSON array")
    return payload


def _latest_rows(rows: list[dict[str, str]], key: str) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for row in rows:
        normalized = normalize_name(row.get(key))
        if normalized:
            result[normalized] = row
    return result


def build_form_indices(rows: list[dict[str, str]]):
    by_name = _latest_rows(rows, "姓名")
    email_rows: defaultdict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        for key in ("電子郵件", "電子郵件地址"):
            email = normalize_email(row.get(key))
            if email and row not in email_rows[email]:
                email_rows[email].append(row)
    by_email = {
        email: candidates[-1]
        for email, candidates in email_rows.items()
        if len({normalize_name(row.get("姓名")) for row in candidates}) == 1
    }
    return by_email, by_name


def find_form_row(
    instructor: dict[str, Any],
    by_email: dict[str, dict[str, str]],
    by_name: dict[str, dict[str, str]],
) -> tuple[dict[str, str] | None, str | None]:
    for field in ("email_primary", "email_secondary"):
        email = normalize_email(instructor.get(field))
        if email and email in by_email:
            return by_email[email], "form_email"
    name = normalize_name(instructor.get("full_name"))
    if name and name in by_name:
        return by_name[name], "form_name"
    return None, None


def completion_missing_count(record: dict[str, Any]) -> int:
    missing = sum(
        not has_value(record.get(field))
        or (
            field == "bio_notes"
            and (clean(record.get(field)) or "").startswith("[通訊地址]")
        )
        for field in REQUIRED_FIELDS
    )
    if not record.get("teaching_regions"):
        missing += 1
    for document in ("id_front", "id_back", "bankbook"):
        if not has_value(record.get(f"{document}_path")) and not has_value(record.get(f"{document}_external_url")):
            missing += 1
    return missing


def reconcile_instructor(
    instructor: dict[str, Any],
    form_row: dict[str, str] | None,
    teacher_row: dict[str, str] | None,
    institutions: dict[str, FinancialInstitution],
) -> dict[str, Any]:
    candidate = dict(instructor)
    changes: dict[str, Any] = {}
    sources: dict[str, str] = {}

    def fill(field: str, value: Any, source: str):
        if has_value(candidate.get(field)) or not has_value(value):
            return
        candidate[field] = value
        changes[field] = value
        sources[field] = source

    registered_source = clean(form_row.get(FORM_FIELDS["household_address"])) if form_row else None
    mailing_source = clean(form_row.get(FORM_FIELDS["address"])) if form_row else None
    if not registered_source and teacher_row:
        registered_source = clean(teacher_row.get(TEACHER_FIELDS["household_address"]))
    if not mailing_source and teacher_row:
        mailing_source = clean(teacher_row.get(TEACHER_FIELDS["address"]))

    # The old importer placed the registered address in `address` and hid the
    # mailing address in a bio marker. Correct only that exact historical shape;
    # arbitrary non-empty addresses are never overwritten.
    legacy_mailing_marker = f"[通訊地址] {mailing_source}" if mailing_source else None
    if (
        registered_source
        and mailing_source
        and registered_source != mailing_source
        and not has_value(candidate.get("household_address"))
        and clean(candidate.get("address")) == registered_source
        and clean(candidate.get("bio_notes")) == legacy_mailing_marker
    ):
        candidate["address"] = mailing_source
        changes["address"] = mailing_source
        sources["address"] = "known_legacy_address_swap"

    for field, form_field in FORM_FIELDS.items():
        if not form_row:
            continue
        value: Any = clean(form_row.get(form_field))
        if field == "birth_date":
            value = parse_date(value)
        fill(field, value, "latest_form")

    for field, teacher_field in TEACHER_FIELDS.items():
        if not teacher_row:
            continue
        value = clean(teacher_row.get(teacher_field))
        if field == "birth_date":
            value = parse_date(value)
        fill(field, value, "teacher_roster")

    fill("nickname", candidate.get("line_name") or candidate.get("full_name"), "safe_fallback")
    fill("gender", derive_gender(candidate.get("id_number")), "taiwan_id_marker")

    regions = parse_regions(candidate.get("teaching_regions_raw"))
    if not candidate.get("teaching_regions") and regions:
        candidate["teaching_regions"] = regions
        changes["teaching_regions"] = regions
        sources["teaching_regions"] = "legacy_regions"

    existing_bio = clean(candidate.get("bio_notes"))
    composed_bio = compose_bio(candidate)
    if composed_bio and (not existing_bio or existing_bio.startswith("[通訊地址]")):
        candidate["bio_notes"] = composed_bio
        changes["bio_notes"] = composed_bio
        sources["bio_notes"] = "legacy_bio_fields"

    bank_fields = parse_legacy_bank_info(
        candidate.get("bank_info_raw"),
        candidate.get("full_name"),
        institutions,
    )
    if bank_fields:
        for field, value in bank_fields.items():
            fill(field, value, "official_bank_directory")

    return {
        "id": instructor["id"],
        "expected_updated_at": instructor.get("updated_at"),
        "before_missing": completion_missing_count(instructor),
        "after_missing": completion_missing_count(candidate),
        "changes": changes,
        "sources": sources,
    }


def reconcile_all(
    instructors: list[dict[str, Any]],
    form_rows: list[dict[str, str]],
    teacher_rows: list[dict[str, str]],
    institutions: dict[str, FinancialInstitution],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    form_by_email, form_by_name = build_form_indices(form_rows)
    teacher_by_name = _latest_rows(teacher_rows, "姓名")
    patches = []
    match_counts: Counter[str] = Counter()
    field_counts: Counter[str] = Counter()

    for instructor in instructors:
        form_row, matched_by = find_form_row(instructor, form_by_email, form_by_name)
        match_counts[matched_by or "form_unmatched"] += 1
        teacher_row = teacher_by_name.get(normalize_name(instructor.get("full_name")))
        if teacher_row:
            match_counts["teacher_name"] += 1
        patch = reconcile_instructor(instructor, form_row, teacher_row, institutions)
        if patch["changes"]:
            patches.append(patch)
            field_counts.update(patch["changes"].keys())

    before_complete = sum(completion_missing_count(row) == 0 for row in instructors)
    patch_by_id = {patch["id"]: patch for patch in patches}
    after_complete = sum(
        (
            patch_by_id[row["id"]]["after_missing"]
            if row["id"] in patch_by_id
            else completion_missing_count(row)
        ) == 0
        for row in instructors
    )
    summary = {
        "instructors": len(instructors),
        "form_rows": len(form_rows),
        "teacher_rows": len(teacher_rows),
        "patch_rows": len(patches),
        "before_complete": before_complete,
        "after_complete": after_complete,
        "match_counts": dict(sorted(match_counts.items())),
        "field_counts": dict(sorted(field_counts.items())),
        "improved_rows": sum(p["after_missing"] < p["before_missing"] for p in patches),
    }
    return patches, summary


def write_private_json(path: Path, payload: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--production-export", required=True, type=Path)
    parser.add_argument("--form-csv", required=True, type=Path)
    parser.add_argument("--teacher-csv", required=True, type=Path)
    parser.add_argument("--financial-institutions-csv", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    patches, summary = reconcile_all(
        load_production_export(args.production_export),
        load_csv(args.form_csv),
        load_csv(args.teacher_csv),
        load_financial_institutions(args.financial_institutions_csv),
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    if args.output:
        write_private_json(args.output, patches)
        print(f"private patch written: {args.output} (mode 0600)")


if __name__ == "__main__":
    main()
