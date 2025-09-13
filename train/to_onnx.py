# train/to_onnx.py
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType
import joblib, pathlib, json, onnx

# Raíz del proyecto (ajústalo si tu layout difiere)
BASE = pathlib.Path(__file__).resolve().parents[1]   # .../binance-futures-bot-ts
MODEL_DIR = BASE / 'models'
MODEL_DIR.mkdir(parents=True, exist_ok=True)

joblib_path = MODEL_DIR / 'antiLoss_rf.joblib'
onnx_path   = MODEL_DIR / 'antiLoss_rf.onnx'
meta_path   = MODEL_DIR / 'antiLoss_rf_meta.json'

# ¡Importante! Debe coincidir EXACTAMENTE con lo que alimentarás desde TS
FEAT_ORDER = ['adx', 'mlMargin', 'vRatio', 'distTopPct', 'hour']

print('📁 joblib  :', joblib_path)
print('📁 onnx out:', onnx_path)

clf = joblib.load(joblib_path)

# Exporta SIN ZipMap → salida tensorial [N, 2] con probabilidades
onnx_model = convert_sklearn(
    clf,
    initial_types=[('float_input', FloatTensorType([None, len(FEAT_ORDER)]))],
    options={type(clf): {'zipmap': False}},   # <-- clave: evita "Non tensor type..."
    target_opset=13
)

onnx_path.write_bytes(onnx_model.SerializeToString())
meta_path.write_text(json.dumps({"feature_order": FEAT_ORDER}, indent=2))

# Verificación rápida de outputs
m = onnx.load(onnx_path)
print('🔎 ONNX outputs:', [o.name for o in m.graph.output])

print('✅ ONNX guardado en:', onnx_path.resolve())
print('📝 feature_order  :', FEAT_ORDER)
