const express = require('express');
const router = express.Router();
const kids = require('../controllers/kidsController');

// routers/kidsRouter.js
router.get('/tasks', (req,res,next)=>{
  console.log('kidsRouter /kids/tasks HIT');
  next();
}, kidsController.listChildTasks);

router.post('/tasks/mark-done', kids.markChildDone);
router.get('/score/daily', kids.dailyScore);

module.exports = router;
