// fetchData.js
const yahooFinance = require('yahoo-finance2').default;

// Optionally suppress the deprecation notice.
yahooFinance.suppressNotices(['ripHistorical']);

(async () => {
  try {
    // Define the time range for one year using Date objects.
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (365 * 24 * 60 * 60 * 1000)); // One year ago

    // Use the chart() method with Date objects for period1 and period2.
    const data = await yahooFinance.chart("AAPL", {
      period1: startDate,
      period2: endDate,
      interval: "1d"
    });

    console.log("Historical data for AAPL:", data);
  } catch (error) {
    console.error("Error fetching data:", error);
  }
})();
