const express = require("express")
const router = express.Router()
const Policy = require("../models/Policy")

router.post("/create", async(req,res)=>{

 let basePremium = 20
 let riskScore = Math.floor(Math.random()*20)

 let premium = basePremium + riskScore

 const policy = new Policy({
 userId:req.body.userId,
 premium:premium,
 coverage:1500,
 status:"Active"
 })

 await policy.save()

 res.json(policy)

})

module.exports = router