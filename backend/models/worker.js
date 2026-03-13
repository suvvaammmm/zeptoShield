const mongoose = require("mongoose")

const workerSchema = new mongoose.Schema({

name:String,
city:String,
vehicle:String,

location:{
lat:Number,
lng:Number
},

claimCount:{
type:Number,
default:0
},

policy:{
coverage:Number,
weeklyPremium:Number,
active:Boolean
}

})

module.exports = mongoose.model("Worker",workerSchema)