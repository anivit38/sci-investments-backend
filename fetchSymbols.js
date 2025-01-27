const yahooFinance = require("yahoo-finance2").default;
const fs = require("fs");

async function fetchSymbols() {
    console.log("Fetching stock symbols...");
    
    const exchanges = {
        "NASDAQ": [],
        "NYSE": [],
        "TSX": []
    };

    const searchQueries = {
        "NASDAQ": "NASDAQ",
        "NYSE": "NYSE",
        "TSX": "TSX"
    };

    for (const [exchange, query] of Object.entries(searchQueries)) {
        try {
            console.log(`Fetching ${exchange} stocks...`);
            const data = await yahooFinance.search(query);

            if (data?.quotes) {
                const symbols = data.quotes.map(quote => quote.symbol);
                exchanges[exchange] = symbols;
                console.log(`✅ Found ${symbols.length} stocks for ${exchange}`);
            } else {
                console.log(`⚠️ No symbols found for ${exchange}`);
            }
        } catch (error) {
            console.error(`❌ Error fetching ${exchange} symbols:`, error.message);
        }
    }

    fs.writeFileSync("symbols.json", JSON.stringify(exchanges, null, 2));
    console.log("✅ Saved symbols.json with categorized exchanges.");
}

fetchSymbols().catch(err => console.error("Error in fetchSymbols:", err.message));
