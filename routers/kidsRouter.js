const express = require('express');
const router = express.Router();
const kids = require('../controllers/kidsController');

router.get('/tasks', kids.listChildTasks);
router.post('/tasks/mark-done', kids.markChildDone);
router.get('/score/daily', kids.dailyScore);

module.exports = router;
