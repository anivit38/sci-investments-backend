const fs = require('fs');

// Path to your symbols.json file
const filePath = './symbols.json';

try {
    // Read and parse the symbols.json file
    const symbols = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Validate each symbol
    const validSymbols = symbols.filter(symbol => typeof symbol === 'string' && symbol.trim() !== '');
    const invalidSymbols = symbols.filter(symbol => typeof symbol !== 'string' || symbol.trim() === '');

    // Log results
    console.log(`Total Symbols: ${symbols.length}`);
    console.log(`Valid Symbols: ${validSymbols.length}`);
    console.log(`Invalid Symbols: ${invalidSymbols.length}`);

    // Optionally write the valid symbols back to the file
    fs.writeFileSync(filePath, JSON.stringify(validSymbols, null, 2), 'utf-8');
    console.log('Valid symbols have been saved back to symbols.json');
} catch (error) {
    console.error('Error validating symbols.json:', error.message);
}
