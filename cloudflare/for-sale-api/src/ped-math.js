// T-027: decimal operations on the decimal representation of finite Numbers.
// BigInts stay internal: APIs, SQLite and Sheets continue receiving Numbers.
function createPedMath() {
  const parts = value => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Montant non fini");
    const [mantissa, exponent = "0"] = String(number).split("e");
    const scale = (mantissa.split(".")[1] || "").length - Number(exponent);
    return { n: BigInt(mantissa.replace(".", "")), scale };
  };
  const number = (n, scale) => Number(String(n) + "e" + (-scale));
  const add = (a, b) => {
    const x = parts(a), y = parts(b), scale = Math.max(x.scale, y.scale);
    return number(x.n * BigInt(10) ** BigInt(scale - x.scale) + y.n * BigInt(10) ** BigInt(scale - y.scale), scale);
  };
  const multiply = (a, b) => {
    const x = parts(a), y = parts(b);
    return number(x.n * y.n, x.scale + y.scale);
  };
  const round = (value, decimals = 2) => {
    const x = parts(value);
    if (x.scale <= decimals) return Number(value);
    const divisor = BigInt(10) ** BigInt(x.scale - decimals);
    const sign = x.n < BigInt(0) ? -BigInt(1) : BigInt(1), abs = x.n * sign;
    return number(sign * ((abs + divisor / BigInt(2)) / divisor), decimals);
  };
  const format = (value, language = "EN") => {
    const x = parts(value || 0), negative = x.n < BigInt(0);
    let digits = String(negative ? -x.n : x.n);
    if (x.scale < 0) digits += "0".repeat(-x.scale);
    else digits = digits.padStart(x.scale + 1, "0");
    const split = x.scale > 0 ? digits.length - x.scale : digits.length;
    const integer = digits.slice(0, split);
    const fraction = digits.slice(split).replace(/0+$/, "").padEnd(2, "0");
    return (negative ? "-" : "") + integer + (language === "FR" ? "," : ".") + fraction;
  };
  const markup = (kind, value, member = false, rate = 0) => {
    if (!["percent", "ped"].includes(kind) || value == null || !Number.isFinite(Number(value))) return {kind:"none",value:null};
    const factor = multiply(member ? 0.5 : 1, add(1, -Number(rate || 0)));
    return {kind, value: kind === "percent" ? add(1, multiply(add(value, -1), factor)) : multiply(value, factor)};
  };
  const price = (unit, quantity, kind, value) => {
    const sale = kind === "percent" ? multiply(unit, value) : kind === "ped" ? add(unit, value) : Number(unit);
    return {unitSalePed:sale, lineTtPed:multiply(unit, quantity), lineSalePed:multiply(sale, quantity)};
  };
  return Object.freeze({add, multiply, round, format, markup, price, sum: values => values.reduce(add, 0)});
}

export const pedMath = createPedMath();

