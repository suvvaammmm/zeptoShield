const mongoose = require("mongoose")

const claimSchema = new mongoose.Schema({
 userId:String,
 disruption:String,
 payout:Number,
 status:String
})

module.exports = mongoose.model("Claim", claimSchema)