// prepareData.js
const yahooFinance = require('yahoo-finance2').default;
const fs = require('fs');

// Define time range for one year.
const endTime = Math.floor(Date.now() / 1000); // current time in seconds
const startTime = endTime - (365 * 24 * 60 * 60); // one year ago

(async () => {
  try {
    // Fetch one year of daily data for AAPL using the chart() method
    const rawData = await yahooFinance.chart("AAPL", {
      period1: startTime,
      period2: endTime,
      interval: "1d"
    });
    
    // Ensure data exists in rawData.quotes
    if (!rawData || !rawData.quotes) {
      throw new Error("No data returned from Yahoo Finance");
    }

    // Clean & format the data: convert date to ISO string and keep desired fields
    const cleanedData = rawData.quotes.map(item => ({
      date: new Date(item.date).toISOString(),
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      adjclose: item.adjclose,
      volume: item.volume
    }));

    // Compute additional feature: daily return
    const enhancedData = cleanedData.map((item, index, arr) => {
      if (index === 0) {
        return { ...item, dailyReturn: 0 };
      }
      const prevClose = arr[index - 1].close;
      const dailyReturn = prevClose ? (item.close / prevClose) - 1 : 0;
      return { ...item, dailyReturn };
    });

    // Save the preprocessed data to a JSON file
    fs.writeFileSync("preprocessedData.json", JSON.stringify(enhancedData, null, 2));
    console.log("Preprocessed data saved to preprocessedData.json");
  } catch (error) {
    console.error("Error preparing data:", error);
  }
})();
