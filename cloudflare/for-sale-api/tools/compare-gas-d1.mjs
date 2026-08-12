const [gasUrl, d1Url] = process.argv.slice(2);

if (!gasUrl || !d1Url) {
  throw new Error("Usage: node tools/compare-gas-d1.mjs <gas-url> <d1-url>");
}

async function getJson(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { redirect: "follow" });
    if (response.ok) return response.json();
    if (attempt === attempts) {
      const details = (await response.text()).slice(0, 200);
      throw new Error(`${response.status} ${response.statusText} pour ${url}: ${details}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
}

const [gasCategories, d1Categories] = await Promise.all([
  getJson(`${gasUrl}?action=categories`),
  getJson(`${d1Url}/?action=categories`)
]);

if (!Array.isArray(gasCategories) || !Array.isArray(d1Categories)) {
  console.error(JSON.stringify({ gasCategories, d1Categories }, null, 2));
  throw new Error("La réponse categories de GAS ou D1 n'est pas un tableau");
}

const categories = [...new Set([...gasCategories, ...d1Categories])].sort();
const comparisons = [];
for (const category of categories) {
  const [gasRows, d1Rows] = await Promise.all([
    getJson(`${gasUrl}?category=${encodeURIComponent(category)}`),
    getJson(`${d1Url}/?category=${encodeURIComponent(category)}`)
  ]);
  const gasItems = new Set(gasRows.map((row) => row.ITEM));
  const d1Items = new Set(d1Rows.map((row) => row.ITEM));
  comparisons.push({
    category,
    gas: gasRows.length,
    d1: d1Rows.length,
    onlyGas: [...gasItems].filter((item) => !d1Items.has(item)),
    onlyD1: [...d1Items].filter((item) => !gasItems.has(item))
  });
}

console.log(JSON.stringify({
  categories: {
    gas: gasCategories,
    d1: d1Categories,
    onlyGas: gasCategories.filter((category) => !d1Categories.includes(category)),
    onlyD1: d1Categories.filter((category) => !gasCategories.includes(category))
  },
  comparisons
}, null, 2));
