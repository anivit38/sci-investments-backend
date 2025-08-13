// flattenSymbols.js
const fs = require("fs");
const path = require("path");

const symbolsPath = path.join(__dirname, "symbols.json");
const rawData = fs.readFileSync(symbolsPath, "utf8");
const data = JSON.parse(rawData);

let flattened = [];

for (const [exchange, symbolArray] of Object.entries(data)) {
  symbolArray.forEach((symbol) => {
    flattened.push({
      symbol: symbol,
      exchange: exchange
    });
  });
}

const newPath = path.join(__dirname, "flattened-symbols.json");
fs.writeFileSync(newPath, JSON.stringify(flattened, null, 2));

console.log(`Flattened symbols with exchange saved to ${newPath}`);
