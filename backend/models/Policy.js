const mongoose = require("mongoose")

const policySchema = new mongoose.Schema({
 userId:String,
 premium:Number,
 coverage:Number,
 status:String
})

module.exports = mongoose.model("Policy", policySchema)