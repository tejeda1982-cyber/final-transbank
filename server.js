// server.js - versión ES Module lista para Render

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Resend } from "resend";
import { WebpayPlus } from "transbank-sdk";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ================================
// RUTAS
// ================================

app.post("/cotizar", async (req, res) => {
  try {
    const { inicio, destino } = req.body;

    if (!inicio || !destino) {
      return res.status(400).json({ error: "Debes indicar inicio y destino" });
    }

    // Ejemplo de cálculo ficticio
    const distancia_km = Math.floor(Math.random() * 20) + 5;
    const valor_base = distancia_km * 500;
    const iva = Math.round(valor_base * 0.19);
    const total = valor_base + iva;
    const mensajeHorario = "Cotización automática";

    res.json({ inicio, destino, distancia_km, valor_base, iva, total, mensajeHorario });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error calculando la cotización" });
  }
});

app.post("/enviar-cotizacion", async (req, res) => {
  try {
    const { nombre, telefono, email, inicio, destino, total } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Falta correo electrónico" });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: "info@tumotoexpress.cl",
      to: email,
      subject: "Cotización TuMotoExpress.cl",
      html: `<p>Hola ${nombre},</p>
             <p>Gracias por cotizar con TuMotoExpress.cl</p>
             <p>Origen: ${inicio}<br>Destino: ${destino}<br>Total: $${total}</p>`
    });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error enviando cotización" });
  }
});

app.post("/crear-transaccion", async (req, res) => {
  try {
    const { total, nombre, email } = req.body;

    if (!total) return res.status(400).json({ error: "Monto no especificado" });

    const webpay = new WebpayPlus.Transaction();

    const createResponse = await webpay.create({
      buy_order: `order-${Date.now()}`,
      session_id: `session-${Date.now()}`,
      amount: total,
      return_url: process.env.WEBPAY_RETURN_URL || "https://tuapp.cl/resultado",
    });

    res.json({ url: createResponse.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error creando transacción" });
  }
});

// ================================
// INICIAR SERVIDOR
// ================================

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});