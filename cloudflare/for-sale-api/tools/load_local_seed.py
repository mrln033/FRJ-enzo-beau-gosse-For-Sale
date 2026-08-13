"""Charge le seed dans une persistance D1 locale créée par Wrangler."""

import sqlite3
import sys
from pathlib import Path


def main():
    persistence = Path(sys.argv[1]).resolve()
    seed = Path(__file__).resolve().parents[1] / "seed" / "initial.sql"
    for candidate in persistence.rglob("*.sqlite"):
        database = sqlite3.connect(candidate)
        names = {row[0] for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type = ?", ("table",)
        )}
        if "catalog_items" not in names:
            database.close()
            continue
        database.executescript(seed.read_text(encoding="utf-8"))
        database.commit()
        print(candidate)
        print(database.execute(
            "SELECT avatar_id, COUNT(*), SUM(quantity), ROUND(SUM(value_ped), 6) "
            "FROM inventory_current GROUP BY avatar_id ORDER BY avatar_id"
        ).fetchall())
        print("MU", database.execute("SELECT COUNT(*) FROM market_current").fetchone()[0])
        print("Catalogue", database.execute("SELECT COUNT(*) FROM catalog_current").fetchone()[0])
        database.close()
        return
    raise RuntimeError("Base D1 locale active introuvable")


if __name__ == "__main__":
    main()
