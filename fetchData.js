// fetchData.js
const yahooFinance = require('yahoo-finance2').default;

// Optionally suppress the deprecation notice.
yahooFinance.suppressNotices(['ripHistorical']);

(async () => {
  try {
    // Define the time range for one year.
    const endTime = Math.floor(Date.now() / 1000); // Current time in seconds
    const startTime = endTime - (365 * 24 * 60 * 60); // One year ago

    // Use the chart() method instead of historical()
    const data = await yahooFinance.chart("AAPL", {
      period1: startTime,
      period2: endTime,
      interval: "1d"
    });

    console.log("Historical data for AAPL:", data);
  } catch (error) {
    console.error("Error fetching data:", error);
  }
})();
