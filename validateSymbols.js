const fs = require("fs");
const path = require("path");

// ✅ Use absolute path for better compatibility (Render support)
const filePath = path.resolve(__dirname, "symbols.json");

try {
  if (!fs.existsSync(filePath)) {
    throw new Error("symbols.json file not found! Please ensure it exists.");
  }

  // Read & parse file
  const rawData = fs.readFileSync(filePath, "utf8");
  const symbolsData = JSON.parse(rawData);

  if (typeof symbolsData !== "object" || Array.isArray(symbolsData)) {
    throw new Error("Invalid symbols.json format. Expected an object with exchanges as keys.");
  }

  let totalSymbols = 0;
  let validSymbolsData = {};
  let invalidSymbols = [];

  // Validate each exchange
  Object.keys(symbolsData).forEach((exchange) => {
    const symbols = symbolsData[exchange];

    if (!Array.isArray(symbols)) {
      console.error(`❌ Invalid data for exchange "${exchange}". Expected an array.`);
      return;
    }

    const validSymbols = symbols.filter((symbol) => typeof symbol === "string" && symbol.trim() !== "");
    const invalid = symbols.filter((symbol) => typeof symbol !== "string" || symbol.trim() === "");

    totalSymbols += symbols.length;
    validSymbolsData[exchange] = validSymbols;
    invalidSymbols.push(...invalid.map((symbol) => ({ exchange, symbol })));
  });

  // ✅ Log Results
  console.log(`🔍 Total Symbols Processed: ${totalSymbols}`);
  console.log(`✅ Valid Symbols: ${Object.values(validSymbolsData).flat().length}`);
  console.log(`❌ Invalid Symbols: ${invalidSymbols.length}`);

  if (invalidSymbols.length > 0) {
    console.log("🛑 Invalid Symbols Found:", JSON.stringify(invalidSymbols, null, 2));
  }

  // ✅ Write back only if changes are needed
  if (invalidSymbols.length > 0) {
    fs.writeFileSync(filePath, JSON.stringify(validSymbolsData, null, 2), "utf8");
    console.log("✅ Cleaned symbols have been saved to symbols.json");
  } else {
    console.log("✅ No invalid symbols found. No changes made.");
  }
} catch (error) {
  console.error("❌ Error validating symbols.json:", error.message);
}
