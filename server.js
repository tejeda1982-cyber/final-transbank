require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch"); // versión 2.x
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// Servir HTML y archivos estáticos
app.use(express.static(__dirname));
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));

app.get("/health",(req,res)=>res.json({status:"OK"}));

// TARIFAS
const TARIFAS_FILE = path.join(__dirname, "tarifas.json");
function leerTarifas(){ 
  try { 
    return JSON.parse(fs.readFileSync(TARIFAS_FILE,"utf8")); 
  } catch { 
    return { tarifa_base:6000, km_adicional_6_10:1000, km_adicional_10_mas:850, cupones:{} }; 
  } 
}
let {tarifa_base,km_adicional_6_10,km_adicional_10_mas,cupones} = leerTarifas();
let porcentajeAjuste = 0;

// CALCULAR DISTANCIA GOOGLE
async function calcularDistancia(inicio,destino){
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(inicio)}&destination=${encodeURIComponent(destino)}&region=CL&mode=driving&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if(data.status!=="OK"){ 
      console.error("Google Directions API error:", data.error_message||data.status); 
      return null; 
    }
    return data.routes?.[0]?.legs?.[0]?.distance?.value ? data.routes[0].legs[0].distance.value/1000 : null;
  } catch(err){ 
    console.error("Error fetch Google Directions API:",err); 
    return null; 
  }
}

// CALCULAR PRECIO
function calcularPrecio(distancia_km,codigo_cupon=""){
  let neto = 0;
  if(distancia_km<=6) neto = tarifa_base;
  else if(distancia_km<=10) neto = Math.round(distancia_km*km_adicional_6_10);
  else neto = Math.round(distancia_km*km_adicional_10_mas);
  if(porcentajeAjuste>0) neto = Math.round(neto*(1+porcentajeAjuste/100));

  let descuentoValor=0, descuentoTexto="";
  if(codigo_cupon && cupones[codigo_cupon.toUpperCase()]){
    const porcentaje = cupones[codigo_cupon.toUpperCase()];
    descuentoValor = Math.round(neto*(porcentaje/100));
    descuentoTexto = `Descuento ${codigo_cupon.toUpperCase()} ${porcentaje}%`;
  }
  const netoConDescuento = neto - descuentoValor;
  const iva = Math.round(netoConDescuento*0.19);
  const total = netoConDescuento + iva;
  return {neto,descuentoValor,descuentoTexto,iva,total,netoConDescuento};
}

// FUNCIÓN PARA OBTENER MENSAJE DE HORARIO (la misma del frontend)
function obtenerMensajeHoraEstimado() {
    const ahora = new Date();
    const dia = ahora.getDay();
    const hora = ahora.getHours();
    const minutos = ahora.getMinutes();
    const diasSemana = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
    
    function sumar80Minutos(fecha) { 
        return new Date(fecha.getTime() + 80 * 60000); 
    }

    if (dia >= 1 && dia <= 4 && hora < 9) {
        return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, pero podemos gestionar tu servicio para hoy ${diasSemana[dia]} durante la mañana (sujeto a disponibilidad).`;
    }
    if (dia >= 1 && dia <= 5) {
        if (hora >= 9 && (hora < 15 || (hora === 15 && minutos <= 40))) {
            const fechaEstimado = sumar80Minutos(ahora);
            return `Gracias por cotizar en TuMotoExpress.cl. Podemos gestionar tu servicio a partir de las ${fechaEstimado.getHours().toString().padStart(2,'0')}:${fechaEstimado.getMinutes().toString().padStart(2,'0')} horas aproximadamente (sujeto a disponibilidad).`;
        }
    }
    if (dia >= 1 && dia <= 4 && hora > 15) {
        const manana = new Date(ahora); 
        manana.setDate(ahora.getDate()+1);
        return `Gracias por cotizar en TuMotoExpress.cl. Fuera de horario comercial, podemos gestionar tu servicio para mañana ${diasSemana[manana.getDay()]} durante la mañana (sujeto a disponibilidad).`;
    }
    const lunes = new Date(ahora); 
    while(lunes.getDay()!==1){
        lunes.setDate(lunes.getDate()+1);
    }
    return `Gracias por cotizar en TuMotoExpress.cl. Fuera de horario comercial, podemos gestionar tu servicio para el lunes durante la mañana (sujeto a disponibilidad).`;
}

// ENVIAR CORREO (fúnica función que envía el mismo template a cliente y copia a nosotros)
async function enviarCorreos(cliente, cotizacion) {
    if(!cliente?.correo) return;
    
    const templatePath = path.join(__dirname, "correotemplate.html");
    let htmlTemplate = "";
    
    try {
        htmlTemplate = fs.readFileSync(templatePath, "utf8");
        
        // Obtener mensaje de horario
        const mensajeHorario = obtenerMensajeHoraEstimado();
        
        // Formatear números como moneda chilena
        const formatearNumero = (num) => {
            return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
        };
        
        // Reemplazar variables en el template
        htmlTemplate = htmlTemplate
            .replace(/{{nombre}}/g, cliente.nombre || "Cliente")
            .replace(/{{origen}}/g, cotizacion.inicio || "")
            .replace(/{{destino}}/g, cotizacion.destino || "")
            .replace(/{{distancia}}/g, cotizacion.distancia_km ? cotizacion.distancia_km.toFixed(2) : "0")
            .replace(/{{neto}}/g, formatearNumero(cotizacion.neto || 0))
            .replace(/{{descuento}}/g, cotizacion.descuentoValor ? formatearNumero(cotizacion.descuentoValor) : "0")
            .replace(/{{iva}}/g, formatearNumero(cotizacion.iva || 0))
            .replace(/{{total}}/g, formatearNumero(cotizacion.total || 0))
            .replace(/{{telefono}}/g, cliente.telefono || "")
            .replace(/{{mensajeHorario}}/g, mensajeHorario)
            .replace(/{{fecha}}/g, new Date().toLocaleString("es-CL"));
            
        // Si no hay descuento, ocultar esa fila
        if (!cotizacion.descuentoValor || cotizacion.descuentoValor === 0) {
            htmlTemplate = htmlTemplate.replace(/\{\{#if descuento\}[\s\S]*?\{\{\/if\}\}/g, '');
        } else {
            htmlTemplate = htmlTemplate
                .replace(/\{\{#if descuento\}\}/g, '')
                .replace(/\{\{\/if\}\}/g, '');
        }
        
    } catch(err) {
        console.error("Error leyendo template de correo:", err);
        // Template de respaldo simple
        htmlTemplate = `
            <h2>Hola ${cliente.nombre || "cliente"}</h2>
            <p><strong>Origen:</strong> ${cotizacion.inicio}</p>
            <p><strong>Destino:</strong> ${cotizacion.destino}</p>
            <p><strong>Distancia:</strong> ${cotizacion.distancia_km ? cotizacion.distancia_km.toFixed(2) : "0"} km</p>
            <p><strong>Total:</strong> $${cotizacion.total}</p>
        `;
    }
    
    try {
        // ENVIAR AL CLIENTE
        await resend.emails.send({
            from: process.env.FROM_EMAIL || "onboarding@resend.dev",
            to: cliente.correo,
            subject: `🚀 Tu cotización en TuMotoExpress.cl - $${cotizacion.total}`,
            html: htmlTemplate
        });
        console.log("✅ Correo enviado al cliente:", cliente.correo);
        
        // ENVIAR LA MISMA COPIA A NOSOTROS (para estadísticas)
        await resend.emails.send({
            from: process.env.FROM_EMAIL || "onboarding@resend.dev",
            to: ["contacto@tumotoexpress.cl"], // COPIA PARA ESTADÍSTICAS
            subject: `📊 [COPIA ESTADÍSTICAS] Cotización para ${cliente.nombre || "cliente"} - $${cotizacion.total}`,
            html: htmlTemplate // EL MISMO TEMPLATE EXACTO
        });
        console.log("✅ Copia enviada a contacto@tumotoexpress.cl para estadísticas");
        
        return true;
    } catch(err) { 
        console.error("Error enviando correos:", err.message); 
        return false;
    }
}

// ENDPOINT COTIZAR
app.post("/cotizar", async(req,res)=>{
  try{
    const {inicio,destino,cupon,nombre,correo,telefono} = req.body;
    
    if(!inicio || !destino) {
      return res.status(400).json({error:"Faltan datos de origen o destino"});
    }
    
    // Calcular distancia
    const distancia_km = await calcularDistancia(inicio,destino);
    if(!distancia_km) {
      return res.status(400).json({error:"No se pudo calcular la distancia entre las direcciones. Verifica que las direcciones sean válidas en Chile."});
    }
    
    // Calcular precio
    const resultado = calcularPrecio(distancia_km,cupon);
    
    // Preparar respuesta
    const respuesta = {
      inicio,
      destino,
      distancia_km,
      ...resultado
    };
    
    // Enviar respuesta
    res.json(respuesta);
    
    // Si se proporcionaron datos de cliente, enviar correos
    if(nombre && correo) {
      // Enviar AL CLIENTE y COPIA A NOSOTROS (mismo template)
      enviarCorreos({nombre,correo,telefono}, respuesta).catch(err => 
        console.error("Error en envío de correos:", err)
      );
    }
    
  } catch(error){ 
    console.error("Error en /cotizar:", error); 
    res.status(500).json({error:"Error interno del servidor"}); 
  }
});

// ENDPOINT ESPECÍFICO PARA ENVIAR CORREO (por si necesitas enviar solo el correo)
app.post("/enviar-correo", async(req,res)=>{
  try{
    const {nombre,correo,telefono,inicio,destino,distancia_km,neto,descuentoValor,iva,total} = req.body;
    
    if(!nombre || !correo) {
      return res.status(400).json({error:"Faltan datos del cliente"});
    }
    
    const cotizacion = {
      inicio,
      destino,
      distancia_km,
      neto,
      descuentoValor,
      iva,
      total
    };
    
    // Enviar AL CLIENTE y COPIA A NOSOTROS (mismo template)
    const enviados = await enviarCorreos({nombre,correo,telefono}, cotizacion);
    
    if(enviados) {
      res.json({success:true, message:"Correos enviados correctamente"});
    } else {
      res.status(500).json({error:"Error al enviar correos"});
    }
    
  } catch(error){ 
    console.error("Error en /enviar-correo:", error); 
    res.status(500).json({error:"Error interno del servidor"}); 
  }
});

// SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log(`✅ Servidor corriendo en puerto ${PORT}`));