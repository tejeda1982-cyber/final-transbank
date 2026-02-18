const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 TU API KEY DE OPENROUTESERVICE
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjUxYjcyNGY2OTc1MTQyMjU4MTZmMGE3MmExYzgyNmVmIiwiaCI6Im11cm11cjY0In0=";

// 📍 Endpoint para calcular ruta
app.post("/calcular-ruta", async (req, res) => {
  try {
    const { origen, destino } = req.body;

    if (!origen || !destino) {
      return res.status(400).json({
        error: "Debes enviar origen y destino"
      });
    }

    const response = await axios.post(
      "https://api.openrouteservice.org/v2/directions/driving-car",
      {
        coordinates: [origen, destino]
      },
      {
        headers: {
          Authorization: ORS_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    const data = response.data;
    const distancia = data.routes[0].summary.distance / 1000; // km
    const duracion = data.routes[0].summary.duration / 60; // minutos

    res.json({
      distancia_km: distancia.toFixed(2),
      duracion_minutos: duracion.toFixed(0)
    });

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Error calculando la ruta"
    });
  }
});

// 🚀 Puerto del servidor
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
