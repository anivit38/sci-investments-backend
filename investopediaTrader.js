// investopediaTrader.js
const puppeteer = require('puppeteer');
const readline = require('readline');

/**
 * Prompts the user to enter the confirmation code in the console.
 * @returns {Promise<string>} The confirmation code entered.
 */
function promptForCode() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Enter Investopedia confirmation code: ', (code) => {
      rl.close();
      resolve(code.trim());
    });
  });
}

/**
 * placeTrade:
 * Logs in to Investopedia Simulator and places a trade.
 *
 * @param {Object} tradeData - Contains:
 *    username: Investopedia login username/email,
 *    symbol: Stock symbol (e.g., "AAPL"),
 *    quantity: Number of shares,
 *    action: "buy" or "sell"
 *
 * This implementation uses manual confirmation.
 */
async function placeTrade({ username, symbol, quantity, action }) {
  const browser = await puppeteer.launch({ headless: true }); // Change to false for debugging
  const page = await browser.newPage();

  try {
    // 1. Go to Investopedia Simulator login page (update URL if needed)
    await page.goto('https://www.investopedia.com/simulator/login', { waitUntil: 'networkidle2' });

    // 2. Enter username/email and trigger login
    await page.type('#username', username); // Update selector if necessary
    await page.click('#loginButton');         // Update selector if necessary
    console.log("Login triggered. Please check your email for the confirmation code.");

    // 3. Wait for manual input of confirmation code
    const code = await promptForCode();
    console.log(`Using confirmation code: ${code}`);

    // 4. Enter confirmation code and submit (update selectors as needed)
    await page.type('#confirmationCodeInput', code);
    await Promise.all([
      page.click('#confirmButton'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    // 5. Navigate to trading page (update URL if necessary)
    await page.goto('https://www.investopedia.com/simulator/trade', { waitUntil: 'networkidle2' });

    // 6. Fill in trade details
    await page.type('#symbolInput', symbol);
    await page.type('#quantityInput', String(quantity));

    // 7. Click the appropriate button based on action
    if (action === 'buy') {
      await Promise.all([
        page.click('#buyButton'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
      ]);
    } else if (action === 'sell') {
      await Promise.all([
        page.click('#sellButton'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
      ]);
    } else {
      throw new Error("Invalid action. Use 'buy' or 'sell'.");
    }

    console.log(`Trade placed: ${action} ${quantity} shares of ${symbol}`);
  } catch (error) {
    console.error("Error placing trade:", error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = { placeTrade };
