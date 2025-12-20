#!/home/jasan/Develop/trading_system/binance-futures-bot-ts/.venv/bin/python3
import pandas as pd
import os
import sys

# Configuración de Pandas
pd.set_option('display.max_rows', None)
pd.set_option('display.max_columns', None)
pd.set_option('display.width', 1000)
pd.set_option('display.float_format', '{:,.2f}'.format)

# Resolver rutas absolutas (Soporte para Symlinks)
SCRIPT_PATH = os.path.realpath(__file__)
SCRIPT_DIR = os.path.dirname(SCRIPT_PATH)
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))
CSV_PATH = os.path.join(PROJECT_ROOT, 'analysis', 'operations_history.csv')

def load_data():
    if not os.path.exists(CSV_PATH):
        print(f"❌ No se encontró el archivo de datos: {CSV_PATH}")
        print("Ejecuta primero 'audit_bot'")
        sys.exit(1)
    return pd.read_csv(CSV_PATH)

def show_report():
    df = load_data()
    
    # Limpieza básica
    df['datetime'] = pd.to_datetime(df['datetime'])
    df['net_pnl'] = df['realized_pnl'] - df['commission_paid']
    
    view_df = df[['datetime', 'symbol', 'side_type', 'entry_price', 'price', 'roi_pct', 'net_pnl']].copy()
    view_df.columns = ['Fecha', 'Par', 'Lado', 'Entrada', 'Salida', 'ROI%', 'PnL Neto']
    view_df['Fecha'] = view_df['Fecha'].dt.strftime('%m-%d %H:%M')

    print("\n" + "="*60)
    print(" 📊 REPORTE DE INTELIGENCIA DE TRADING")
    print("="*60)

    wins = df[df['net_pnl'] > 0]
    losses = df[df['net_pnl'] <= 0]
    
    avg_win = wins['net_pnl'].mean() if not wins.empty else 0
    avg_loss = losses['net_pnl'].mean() if not losses.empty else 0
    profit_factor = abs(wins['net_pnl'].sum() / losses['net_pnl'].sum()) if losses['net_pnl'].sum() != 0 else 999
    
    df_sorted = df.sort_values('datetime')
    df_sorted['cumulative'] = df_sorted['net_pnl'].cumsum()
    df_sorted['peak'] = df_sorted['cumulative'].cummax()
    df_sorted['drawdown'] = df_sorted['cumulative'] - df_sorted['peak']
    max_dd = df_sorted['drawdown'].min()

    print("\n--- 1. SIGNOS VITALES ---")
    print(f"PnL Neto Total:     ${df['net_pnl'].sum():.2f}")
    print(f"Win Rate:           {(len(wins)/len(df))*100:.2f}%")
    print(f"Profit Factor:      {profit_factor:.2f} (Ideal > 1.5)")
    print(f"Ratio Riesgo/Ben:   {abs(avg_win/avg_loss):.2f}")
    print(f"Max Drawdown:       ${max_dd:.2f}")

    print("\n--- 2. ANÁLISIS DE ESTRATEGIA (LONG vs SHORT) ---")
    by_side = df.groupby('side_type').agg(
        Ops=('symbol', 'count'),
        PnL_Neto=('net_pnl', 'sum'),
        Win_Rate=('net_pnl', lambda x: (x > 0).mean() * 100)
    )
    print(by_side)

    print("\n--- 3. HALL OF FAME (TOP 5 VICTORIAS) 🏆 ---")
    top_wins = view_df[view_df['PnL Neto'] > 0].sort_values('PnL Neto', ascending=False).head(5)
    print(top_wins.to_string(index=False))

    print("\n--- 4. HALL OF SHAME (TOP 5 PÉRDIDAS) ⚠️ ---")
    top_losses = view_df[view_df['PnL Neto'] <= 0].sort_values('PnL Neto', ascending=True).head(5)
    print(top_losses.to_string(index=False))

    print("\n--- 5. DETALLE DE OPERACIONES EXITOSAS (WINS) ✅ ---")
    wins_view = view_df[view_df['PnL Neto'] > 0].sort_values('Fecha', ascending=False)
    print(wins_view.to_string(index=False))

    print("\n--- 6. DETALLE DE OPERACIONES FALLIDAS (LOSSES) ❌ ---")
    losses_view = view_df[view_df['PnL Neto'] <= 0].sort_values('Fecha', ascending=False)
    print(losses_view.to_string(index=False))

    print("\n--- 7. BITÁCORA COMPLETA (HISTÓRICO) ---")
    print(view_df.sort_values('Fecha', ascending=False).to_string(index=False))
    print("\n" + "="*60)

if __name__ == "__main__":
    show_report()
