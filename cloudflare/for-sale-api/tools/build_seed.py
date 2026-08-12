"""Construit seed/initial.sql depuis les exports XLSX Google, sans modifier les classeurs."""

import hashlib
import re
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]
APP_XLSX = ROOT / "save" / "[FRJ] - FOR SALE App.xlsx"
INVENTORY_XLSX = ROOT / "save" / "[FRJ] - Inventaires Enzo's.xlsx"
OUTPUT = PROJECT / "seed" / "initial.sql"

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"
PARIS = ZoneInfo("Europe/Paris")


def column_number(reference):
    match = re.match(r"([A-Z]+)", reference or "")
    result = 0
    for character in match.group(1) if match else "":
        result = result * 26 + ord(character) - 64
    return result


def read_xlsx(path):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{MAIN}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{MAIN}t")))

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {
            relationship.attrib["Id"]: relationship.attrib["Target"]
            for relationship in relationships.findall(f"{PKG}Relationship")
        }

        def cell_value(cell):
            value_node = cell.find(f"{MAIN}v")
            raw = value_node.text if value_node is not None else None
            kind = cell.attrib.get("t")
            if kind == "s" and raw is not None:
                return shared[int(raw)]
            if kind == "inlineStr":
                inline = cell.find(f"{MAIN}is")
                return "".join(node.text or "" for node in inline.iter(f"{MAIN}t")) if inline is not None else ""
            if kind == "b" and raw is not None:
                return raw == "1"
            return raw

        result = {}
        for sheet in workbook.find(f"{MAIN}sheets"):
            target = targets[sheet.attrib[f"{REL}id"]]
            root = ET.fromstring(archive.read("xl/" + target.lstrip("/")))
            rows = []
            sheet_data = root.find(f"{MAIN}sheetData")
            for row in sheet_data.findall(f"{MAIN}row") if sheet_data is not None else []:
                values = {}
                for cell in row.findall(f"{MAIN}c"):
                    values[column_number(cell.attrib.get("r"))] = cell_value(cell)
                rows.append(values)
            result[sheet.attrib["name"]] = rows
        return result


def text(value):
    return str(value or "").strip()


def number(value):
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def iso_from_excel(value):
    numeric = number(value)
    if numeric is None:
        return None
    local = (datetime(1899, 12, 30) + timedelta(days=numeric)).replace(tzinfo=PARIS)
    return local.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")


def sql(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return format(value, ".15g")
    return "'" + str(value).replace("'", "''") + "'"


def insert_statements(table, columns, records, prefix="INSERT OR REPLACE", max_chars=80_000):
    header = f"{prefix} INTO {table} ({', '.join(columns)}) VALUES\n"
    statements = []
    current = []
    current_size = len(header)
    for record in records:
        row = "(" + ", ".join(sql(value) for value in record) + ")"
        if current and current_size + len(row) + 3 > max_chars:
            statements.append(header + ",\n".join(current) + ";")
            current = []
            current_size = len(header)
        current.append(row)
        current_size += len(row) + 3
    if current:
        statements.append(header + ",\n".join(current) + ";")
    return statements


app = read_xlsx(APP_XLSX)
inventories = read_xlsx(INVENTORY_XLSX)

catalog_by_name = {}
listings = {}
for row in app["BDD_APP"][1:]:
    name = text(row.get(3))
    if not name:
        continue
    catalog_by_name[name.casefold()] = (
        name,
        number(row.get(5)),
        text(row.get(6)) or None,
        text(row.get(7)) or None,
    )
    storage = text(row.get(1)).upper()
    aisle = text(row.get(2)).upper()
    listings[(name.casefold(), storage, aisle)] = (name, storage, aisle, 1)

avatar_sheets = {
    "enzo": "Inventaire Enzo",
    "arkaman": "Inventaire ArkaMan",
    "kenza": "Inventaire Kenza",
    "nocturnal": "Inventaire Nocturnal",
}

inventory_imports = []
inventory_items = []
active_inventories = []
inventory_counts = {}
for avatar, sheet_name in avatar_sheets.items():
    rows = inventories[sheet_name]
    imported_at = iso_from_excel(rows[0].get(2)) or datetime.now(tz=PARIS).astimezone(ZoneInfo("UTC")).isoformat()
    import_id = f"snapshot-inventory-{avatar}"
    parsed = []
    for line_no, row in enumerate(rows[1:], start=2):
        item_name = text(row.get(2))
        quantity = number(row.get(3))
        if not item_name or quantity is None:
            continue
        parsed.append((
            import_id,
            line_no,
            text(row.get(1)) or None,
            item_name,
            quantity,
            number(row.get(4)),
            text(row.get(5)) or None,
            text(row.get(6)) or None,
        ))
    checksum = hashlib.sha256(repr(parsed).encode("utf-8")).hexdigest()
    inventory_imports.append((import_id, avatar, imported_at, len(parsed), checksum))
    inventory_items.extend(parsed)
    active_inventories.append((avatar, import_id))
    inventory_counts[avatar] = len(parsed)

market_rows = []
for line_no, row in enumerate(app["MU_Pondérés"][1:], start=2):
    item_name = text(row.get(2))
    observed_at = iso_from_excel(row.get(1))
    if not item_name or not observed_at:
        continue
    weighted_display = text(row.get(15)) or None
    if weighted_display and weighted_display.endswith("%"):
        weighted_kind = "percent"
        weighted_value = number(weighted_display.replace("%", ""))
        weighted_value = weighted_value / 100 if weighted_value is not None else None
    elif weighted_display and weighted_display.upper().endswith("PED"):
        weighted_kind = "ped"
        weighted_value = number(weighted_display.upper().replace("PED", ""))
    else:
        weighted_kind = None
        weighted_value = None
    market_rows.append((
        "snapshot-market",
        line_no,
        item_name,
        text(row.get(3)) or None,
        text(row.get(4)) or None,
        text(row.get(5)) or None,
        text(row.get(6)) or None,
        text(row.get(7)) or None,
        text(row.get(8)) or None,
        text(row.get(9)) or None,
        text(row.get(10)) or None,
        text(row.get(11)) or None,
        text(row.get(12)) or None,
        text(row.get(13)) or None,
        weighted_kind,
        weighted_value,
        weighted_display,
        observed_at,
    ))

latest_market_date = max((row[-1] for row in market_rows), default=datetime.now(tz=ZoneInfo("UTC")).isoformat())
market_checksum = hashlib.sha256(repr(market_rows).encode("utf-8")).hexdigest()

statements = [
    "PRAGMA foreign_keys = ON;",
    *insert_statements(
        "catalog_items",
        ["name", "unit_price_ped", "image", "wiki_url"],
        list(catalog_by_name.values()),
    ),
    *insert_statements(
        "catalog_listings",
        ["item_name", "storage", "aisle", "enabled"],
        list(listings.values()),
    ),
    *insert_statements(
        "inventory_imports",
        ["id", "avatar_id", "imported_at", "source_row_count", "checksum"],
        inventory_imports,
    ),
    *insert_statements(
        "inventory_items",
        ["import_id", "line_no", "source_id", "item_name", "quantity", "value_ped", "container", "container_ref_id"],
        inventory_items,
    ),
    *insert_statements("active_inventory", ["avatar_id", "import_id"], active_inventories),
    *insert_statements(
        "market_imports",
        ["id", "imported_at", "source_row_count", "checksum"],
        [("snapshot-market", latest_market_date, len(market_rows), market_checksum)],
    ),
    *insert_statements(
        "market_observations",
        [
            "import_id", "line_no", "item_name", "tier",
            "day_markup", "day_sales", "week_markup", "week_sales",
            "month_markup", "month_sales", "year_markup", "year_sales",
            "decade_markup", "decade_sales", "weighted_kind", "weighted_value",
            "weighted_display", "observed_at",
        ],
        market_rows,
    ),
    *insert_statements("active_market_import", ["singleton", "import_id"], [(1, "snapshot-market")]),
]

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text("\n\n".join(statements) + "\n", encoding="utf-8")

print(f"Catalogue : {len(catalog_by_name)} articles / {len(listings)} classements")
print("Inventaires : " + ", ".join(f"{key}={value}" for key, value in inventory_counts.items()))
print(f"MU : {len(market_rows)} observations")
print(f"Seed : {OUTPUT} ({OUTPUT.stat().st_size} octets, {len(statements)} instructions/blocs)")
