require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 Clave privada (NO visible en frontend)
const GOOGLE_KEY = process.env.GOOGLE_MAPS_BACKEND_KEY;

app.post("/cotizar", async (req, res) => {
  try {
    const { origen, destino } = req.body;

    if (!origen || !destino) {
      return res.status(400).json({ error: "Faltan direcciones" });
    }

    if (!GOOGLE_KEY) {
      return res.status(500).json({ error: "API key no configurada en Render" });
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origen)}&destination=${encodeURIComponent(destino)}&region=CL&mode=driving&key=${GOOGLE_KEY}`;

    console.log("🔎 URL enviada a Google:", url.replace(GOOGLE_KEY, "OCULTA"));

    const response = await fetch(url);
    const data = await response.json();

    console.log("📦 Respuesta completa de Google:", data);

    if (data.status !== "OK") {
      return res.status(400).json({
        error: "No se pudo calcular distancia",
        google_status: data.status,
        google_error: data.error_message
      });
    }

    const ruta = data.routes[0];
    const distancia = ruta.legs[0].distance.value; // metros
    const duracion = ruta.legs[0].duration.value; // segundos

    res.json({
      distancia_metros: distancia,
      duracion_segundos: duracion
    });

  } catch (error) {
    console.error("❌ Error servidor:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});