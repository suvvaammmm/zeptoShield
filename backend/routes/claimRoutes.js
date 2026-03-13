const express = require("express")
const router = express.Router()
const Claim = require("../models/Claim")

router.post("/trigger", async(req,res)=>{

 const claim = new Claim({
 userId:req.body.userId,
 disruption:req.body.disruption,
 payout:450,
 status:"Approved"
 })

 await claim.save()

 res.json(claim)

})

module.exports = router