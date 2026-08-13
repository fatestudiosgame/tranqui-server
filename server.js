app.post('/api/comentarios/:negocioId', async (req, res) => {
  console.log(`📡 POST /api/comentarios/${req.params.negocioId}`);
  try {
    const { texto, autor, puntuacion } = req.body;

    if (!texto || texto.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'El texto del comentario es obligatorio'
      });
    }

    const comentarioData = {
      texto: texto.trim(),
      autor: autor?.trim() || 'Anónimo',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      puntuacion: puntuacion || null, // ⬅️ NUEVO (opcional)
    };

    const docRef = await db
      .collection('negocios')
      .doc(req.params.negocioId)
      .collection('comentarios')
      .add(comentarioData);

    // ⭐ Actualizar estadísticas del negocio (promedio y total)
    const negocioRef = db.collection('negocios').doc(req.params.negocioId);
    const negocioDoc = await negocioRef.get();
    const negocioData = negocioDoc.data();

    // Calcular nuevos valores
    const totalComentarios = (negocioData.totalComentarios || 0) + 1;
    const totalPuntuaciones = (negocioData.totalPuntuaciones || 0) + (puntuacion ? 1 : 0);
    const sumaPuntuaciones = (negocioData.sumaPuntuaciones || 0) + (puntuacion || 0);
    const promedioPuntuacion = totalPuntuaciones > 0 
      ? sumaPuntuaciones / totalPuntuaciones 
      : null;

    await negocioRef.update({
      totalComentarios: totalComentarios,
      totalPuntuaciones: totalPuntuaciones,
      sumaPuntuaciones: sumaPuntuaciones,
      promedioPuntuacion: promedioPuntuacion,
    });

    console.log(`✅ Comentario agregado con ID: ${docRef.id}`);
    res.status(201).json({
      success: true,
      message: 'Comentario agregado correctamente',
      id: docRef.id
    });
  } catch (error) {
    console.error('❌ Error al agregar comentario:', error);
    res.status(500).json({
      success: false,
      message: 'Error al agregar comentario',
      error: error.message
    });
  }
});