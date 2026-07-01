import { Router } from 'express';
import { saveDataUriFrame } from './lzFrame.js';

export const mediaRouter = Router();

mediaRouter.post('/lz-frame', async (req, res) => {
  try {
    const dataUrl = req.body && req.body.dataUrl;
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'dataUrl obrigatório' });
    }
    const url = await saveDataUriFrame(dataUrl, req);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message || 'falha ao publicar frame' });
  }
});
