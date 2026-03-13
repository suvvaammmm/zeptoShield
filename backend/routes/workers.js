const express = require("express")
const router = express.Router()

const Worker = require("../models/worker")

router.post("/register", async (req,res)=>{

const {name,city,vehicle} = req.body

const lat = 20.2961 + Math.random()*0.02
const lng = 85.8245 + Math.random()*0.02

const worker = new worker({
name,
city,
vehicle,
location:{lat,lng}
})

await worker.save()

res.json(worker)

})

router.get("/workers", async (req,res)=>{

const workers = await worker.find()

res.json(workers)

})

module.exports = router