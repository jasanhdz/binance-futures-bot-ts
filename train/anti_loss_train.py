# train/anti_loss_abs.py
import pandas as pd, joblib, json, pathlib, os

# ---------- rutas absolutas ----------
BASE_DIR = pathlib.Path(__file__).resolve().parent.parent   # /Users/.../binance-futures-bot-ts
JSON_FILE = BASE_DIR / 'train' / 'bt_StackClassic_XRPUSDT_5m.json'
MODEL_DIR = BASE_DIR / 'models'
MODEL_DIR.mkdir(exist_ok=True)   # crea si no existe

print('📁 JSON:', JSON_FILE)
print('📁 Modelo saldrá en:', MODEL_DIR / 'antiLoss_rf.joblib')

# ---------- carga ----------
with open(JSON_FILE) as f:
    bt = json.load(f)
df = pd.DataFrame(bt['trades'])
df['label'] = (df['pnlPct'] > 0).astype(int)
df['hour'] = pd.to_datetime(df['entryTs'], unit='ms').dt.hour

# ---------- entrena ----------
feat = ['adx','mlMargin','vRatio','distTopPct','hour']
X = df[feat].fillna(0)
y = df['label']

from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.3, random_state=42, stratify=y)
clf = RandomForestClassifier(n_estimators=300, max_depth=5, min_samples_split=10,
                             class_weight='balanced', random_state=42)
clf.fit(X_train, y_train)
print(classification_report(y_test, clf.predict(X_test)))

# ---------- guarda ----------
model_path = MODEL_DIR / 'antiLoss_rf.joblib'
joblib.dump(clf, model_path)
print('✅ Modelo guardado en:', model_path.resolve())