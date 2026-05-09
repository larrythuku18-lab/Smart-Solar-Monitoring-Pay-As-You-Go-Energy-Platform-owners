import express from 'express';
import { handleUSSDRequest } from '../services/africastalking.js';

const router = express.Router();

router.post('/', (req, res) => {
  handleUSSDRequest(req, res);
});

export default router;
