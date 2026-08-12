const baseUrl = process.argv[2];

if (!baseUrl) {
  throw new Error("Usage: node tools/smoke.mjs <base-url>");
}

const health = await fetch(`${baseUrl}/health`);
const healthBody = await health.json();

const categories = await fetch(`${baseUrl}/?action=categories`, {
  headers: { Origin: "https://mrln033.github.io" }
});
const categoryBody = await categories.json();

const armors = await fetch(`${baseUrl}/?category=ARMORS`);
const armorBody = await armors.json();

const inventoryDate = await fetch(`${baseUrl}/?action=inventoryDate`);
const inventoryDateBody = await inventoryDate.json();

const inventoryTarget = await fetch(`${baseUrl}/?action=inventoryTarget&avatar=enzo`);
const inventoryTargetBody = await inventoryTarget.json();

const unauthorized = await fetch(`${baseUrl}/?type=inventory&avatar=enzo`, {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: "Id\tItem\tQuantity\tValue(PED)\tContainer\tContainerRefId"
});
const unauthorizedBody = await unauthorized.json();

console.log(JSON.stringify({
  health: { status: health.status, body: healthBody },
  categories: {
    status: categories.status,
    cors: categories.headers.get("Access-Control-Allow-Origin"),
    count: categoryBody.length,
    body: categoryBody
  },
  armors: { status: armors.status, count: armorBody.length },
  inventoryDate: { status: inventoryDate.status, body: inventoryDateBody },
  inventoryTarget: { status: inventoryTarget.status, body: inventoryTargetBody },
  unauthorized: { status: unauthorized.status, body: unauthorizedBody }
}, null, 2));

if (
  health.status !== 200
  || healthBody.ok !== true
  || categories.status !== 200
  || categories.headers.get("Access-Control-Allow-Origin") !== "https://mrln033.github.io"
  || categoryBody.length === 0
  || armors.status !== 200
  || armorBody.length === 0
  || inventoryDate.status !== 200
  || !inventoryDateBody.inventoryDate
  || inventoryTarget.status !== 200
  || inventoryTargetBody.sheet !== "Inventaire Enzo"
  || unauthorized.status !== 401
) {
  process.exitCode = 1;
}
