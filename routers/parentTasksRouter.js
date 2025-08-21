// routers/parentTasksRouter.js
const express = require('express');
const r = express.Router();
const ctrl = require('../controllers/parentTasksController');

r.get('/review', ctrl.listForReviewDay);
r.post('/approve', ctrl.approveChildTask);
r.post('/reject', ctrl.rejectChildTask);
r.get('/leaderboard/week', ctrl.weekLeaderboard);

module.exports = r;
