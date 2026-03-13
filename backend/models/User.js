const mongoose = require("mongoose")

const userSchema = new mongoose.Schema({
 name:String,
 phone:String,
 city:String,
 zone:String,
 weeklyIncome:Number
})

module.exports = mongoose.model("User", userSchema)