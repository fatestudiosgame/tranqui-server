// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

// Cargar variables de entorno
dotenv.config();

// Inicializar Firebase Admin SDK
// La clave de servicio se cargará desde una variable de entorno (recomendado)
// o desde un archivo JSON local (solo para desarrollo)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // En producción (Vercel/Render), usamos la variable de entorno
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // En desarrollo local, usamos el archivo JSON
  serviceAccount = require('./firebase-key.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Crear la app de Express
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ========== RUTAS DE LA API ==========

// 1. Obtener todos los negocios
app.get('/api/negocios', async (req, res) => {
  try {
    const snapshot = await db.collection('negocios')
      .orderBy('timestamp', 'desc')
      .get();
    
    const negocios = [];
    snapshot.forEach(doc => {
      negocios.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({
      success: true,
      data: negocios
    });
  } catch (error) {
    console.error('Error al obtener negocios:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocios',
      error: error.message
    });
  }
});

// 2. Agregar un nuevo negocio
app.post('/api/negocios', async (req, res) => {
  try {
    const { descripcion, latitud, longitud } = req.body;

    // Validar que los campos requeridos estén presentes
    if (!descripcion || latitud === undefined || longitud === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos requeridos: descripcion, latitud, longitud'
      });
    }

    // Guardar en Firestore
    const docRef = await db.collection('negocios').add({
      descripcion,
      latitud: parseFloat(latitud),
      longitud: parseFloat(longitud),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(201).json({
      success: true,
      message: 'Negocio agregado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('Error al agregar negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar negocio',
      error: error.message
    });
  }
});

// 3. Obtener un negocio específico por ID
app.get('/api/negocios/:id', async (req, res) => {
  try {
    const doc = await db.collection('negocios').doc(req.params.id).get();
    
    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Negocio no encontrado'
      });
    }

    res.json({
      success: true,
      data: {
        id: doc.id,
        ...doc.data()
      }
    });
  } catch (error) {
    console.error('Error al obtener negocio:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener negocio',
      error: error.message
    });
  }
});

// 4. Ruta de salud (health check) para verificar que el servidor está vivo
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// ========== INICIAR SERVIDOR ==========
app.listen(port, () => {
  console.log(`✅ Servidor proxy de Tranqui corriendo en http://localhost:${port}`);
  console.log(`📡 Endpoints disponibles:`);
  console.log(`   GET  /api/negocios  - Obtener todos los negocios`);
  console.log(`   POST /api/negocios  - Agregar un nuevo negocio`);
  console.log(`   GET  /api/negocios/:id - Obtener un negocio específico`);
  console.log(`   GET  /api/health   - Verificar estado del servidor`);
});