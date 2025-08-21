const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/parentTasksController');

// אישורי הורה ליום מסוים
router.get('/review', ctrl.reviewDay);

// אישור / דחייה
router.post('/approve', ctrl.approveTask);
router.post('/reject',  ctrl.rejectTask);

// גרף שבועי (לצ'ארט)
router.get('/leaderboard/week', ctrl.weeklyLeaderboard);

module.exports = router;


