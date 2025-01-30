const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const mongoose = require('mongoose');
const UserModel = require('../models/User');

const app = express();
app.use(cors());
app.use(bodyPalrser.json());

// Updated Port for the Express Server
const PORT = 5002;

// Database Connection
mongoose.connect('mongodb://127.0.0.1:27017/sci_investments', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 100000,
    socketTimeoutMS: 45000, // Ensures timeout is sufficient
})
.then(() => console.log('Connected to MongoDB'))
.catch((err) => console.error('Error connecting to MongoDB:', err));

mongoose.set('debug', true);


// Signup Endpoint
// Signup Endpoint
app.post("/signup", async (req, res) => {
    console.log("Incoming Request Body:", req.body); // Log request body
  
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      console.error("Missing required fields!");
      return res.status(400).json({ message: "All fields are required." });
    }
  
    try {
      // Check if the user already exists
      console.log("Checking if user exists...");
      const existingUser = await UserModel.findOne({ email });
      if (existingUser) {
        console.error("User already exists!");
        return res.status(400).json({ message: "Email already in use." });
      }
  
      console.log("Hashing password...");
      const hashedPassword = await bcrypt.hash(password, 10);

  
      console.log("Saving new user...");
      const user = new UserModel({ email, username, password: hashedPassword });
      await user.save();
  
      console.log("User saved successfully!");
      return res.status(201).json({ message: "User registered successfully." });
    } catch (error) {
      console.error("Signup Error:", error);
      return res.status(500).json({ message: "Error during signup." });
    }
  });
  


// Login Endpoint
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    try {
        // Find the user in the database
        const user = await UserModel.findOne({ username });
        if (!user) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        // Compare the password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        return res.status(200).json({ message: "Login successful." });
    } catch (error) {
        console.error("Login Error:", error);
        return res.status(500).json({ message: "Error during login." });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Auth server running on http://localhost:${PORT}`);
});
