const PED_UNITS = new Map([
  ["PEC", 0.01],
  ["PED", 1],
  ["K", 1_000],
  ["K PED", 1_000],
  ["M", 1_000_000],
  ["M PED", 1_000_000]
]);

export function parseTsv(text) {
  const records = parseTabularRecords(String(text || "").replace(/^\uFEFF/, ""))
    .filter((record) => record.some((value) => value.trim() !== ""));

  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0].map((value) => value.trim());
  const rows = records.slice(1).map((values) => {
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });

  return { headers, rows };
}

function parseTabularRecords(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  const finishField = () => {
    record.push(field);
    field = "";
  };

  const finishRecord = () => {
    finishField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field === "") {
      quoted = true;
    } else if (character === "\t") {
      finishField();
    } else if (character === "\n") {
      finishRecord();
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field !== "" || record.length > 0) finishRecord();
  return records;
}

export function parsePedVolume(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value || value === "N/A") return 0;

  const match = value.match(/^([+-]?[\d.,]+)\s*(M PED|K PED|PEC|PED|M|K)?$/);
  if (!match) return 0;

  const number = Number(match[1].replace(",", "."));
  if (!Number.isFinite(number)) return 0;
  return number * (PED_UNITS.get(match[2] || "PED") || 1);
}

export function parseMarkup(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value || value === "N/A") return null;

  if (value.endsWith("%")) {
    const number = Number(value.slice(0, -1).trim().replace(",", "."));
    return Number.isFinite(number) ? { kind: "percent", value: number / 100 } : null;
  }

  const number = Number(value.replace(/\s*PED$/, "").replace(",", "."));
  return Number.isFinite(number) ? { kind: "ped", value: number } : null;
}

export function computeWeightedMarkup(row) {
  const periods = [
    [row["Day Markup"], row["Day Sales"]],
    [row["Week Markup"], row["Week Sales"]],
    [row["Month Markup"], row["Month Sales"]],
    [row["Year Markup"], row["Year Sales"]]
  ];

  const parsed = periods
    .map(([markup, sales]) => ({ markup: parseMarkup(markup), volume: parsePedVolume(sales) }))
    .filter(({ markup, volume }) => markup && volume > 0);

  const kind = parsed.find(({ markup }) => markup.kind)?.markup.kind || "percent";
  const compatible = parsed.filter(({ markup }) => markup.kind === kind);
  const totalVolume = compatible.reduce((sum, entry) => sum + entry.volume, 0);
  const fallback = kind === "percent" ? 1.01 : 0.5;
  const floor = kind === "percent" ? 1.005 : 0.5;
  const weighted = totalVolume > 0
    ? compatible.reduce((sum, entry) => sum + entry.markup.value * entry.volume, 0) / totalVolume
    : fallback;
  const value = Math.max(weighted, floor);
  const display = kind === "percent"
    ? `${(value * 100).toFixed(2).replace(".", ",")} %`
    : `${value.toFixed(2).replace(".", ",")} PED`;

  return { kind, value, display };
}

export function normalizeInventoryRows(text) {
  const { headers, rows } = parseTsv(text);
  const expected = ["Id", "Quantity", "Value(PED)", "Container", "ContainerRefId"];
  const missing = expected.filter((header) => !headers.includes(header));
  const itemHeader = resolveInventoryItemHeader(headers);
  if (itemHeader === null) missing.splice(1, 0, "Item");
  if (missing.length) throw new Error(`Colonnes inventaire manquantes : ${missing.join(", ")}`);

  return rows
    .map((row, index) => ({
      lineNo: index + 2,
      sourceId: String(row.Id || "").trim() || null,
      itemName: String(row[itemHeader] || "").trim(),
      quantity: Number(String(row.Quantity || "0").replace(",", ".")),
      valuePed: nullableNumber(row["Value(PED)"]),
      container: String(row.Container || "").trim() || null,
      containerRefId: String(row.ContainerRefId || "").trim() || null
    }))
    .filter((row) => row.itemName && Number.isFinite(row.quantity));
}

function resolveInventoryItemHeader(headers) {
  const aliases = new Set(["item", "name", "item name"]);
  const namedHeader = headers.find((header) => aliases.has(header.toLowerCase()));
  if (namedHeader !== undefined) return namedHeader;

  // GAS remplace B1 par la date d'import. Une copie depuis la feuille conserve donc
  // les cinq en-têtes standard, mais la colonne des articles porte une date en B1.
  const hasLegacySheetLayout = headers.length >= 6
    && headers[0] === "Id"
    && headers[2] === "Quantity"
    && headers[3] === "Value(PED)"
    && headers[4] === "Container"
    && headers[5] === "ContainerRefId";

  return hasLegacySheetLayout ? headers[1] : null;
}

export function normalizeMarketRows(text, observedAt) {
  const { headers, rows } = parseTsv(text);
  const expected = [
    "Item", "Tier", "Day Markup", "Day Sales", "Week Markup", "Week Sales",
    "Month Markup", "Month Sales", "Year Markup", "Year Sales", "Decade Markup", "Decade Sales"
  ];
  const missing = expected.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`Colonnes MU manquantes : ${missing.join(", ")}`);

  return rows
    .map((row, index) => {
      const weighted = computeWeightedMarkup(row);
      return {
        lineNo: index + 2,
        itemName: String(row.Item || "").trim(),
        tier: String(row.Tier || "").trim() || null,
        dayMarkup: row["Day Markup"] || null,
        daySales: row["Day Sales"] || null,
        weekMarkup: row["Week Markup"] || null,
        weekSales: row["Week Sales"] || null,
        monthMarkup: row["Month Markup"] || null,
        monthSales: row["Month Sales"] || null,
        yearMarkup: row["Year Markup"] || null,
        yearSales: row["Year Sales"] || null,
        decadeMarkup: row["Decade Markup"] || null,
        decadeSales: row["Decade Sales"] || null,
        weightedKind: weighted.kind,
        weightedValue: weighted.value,
        weightedDisplay: weighted.display,
        observedAt
      };
    })
    .filter((row) => row.itemName);
}

function nullableNumber(value) {
  const number = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}
