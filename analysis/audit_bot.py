#!/home/jasan/Develop/trading_system/binance-futures-bot-ts/.venv/bin/python3
import ccxt
import pandas as pd
import os
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime, timedelta
from dotenv import load_dotenv
import sys
import argparse

# Configuración
plt.switch_backend('Agg')
sns.set_theme(style="darkgrid")

# Resolver rutas absolutas (Soporte para Symlinks)
SCRIPT_PATH = os.path.realpath(__file__)
SCRIPT_DIR = os.path.dirname(SCRIPT_PATH)
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))
DOTENV_PATH = os.path.join(PROJECT_ROOT, '.env')
load_dotenv(DOTENV_PATH)

API_KEY = os.getenv('BINANCE_API_KEY')
API_SECRET = os.getenv('BINANCE_API_SECRET')
TARGET_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'POL/USDT', 'DOGE/USDT']
START_DATE = '2026-01-01T00:00:00Z'

if not API_KEY or not API_SECRET:
    print("❌ Error: Credenciales no encontradas en .env")
    sys.exit(1)

def parse_arguments():
    parser = argparse.ArgumentParser(
        description="""
        🤖 AUDIT BOT - Herramienta de Análisis Forense de Trading
        =======================================================
        Descarga, procesa y analiza el historial de operaciones de Binance Futures.
        Genera reportes CSV y gráficos de rendimiento.
        """,
        formatter_class=argparse.RawTextHelpFormatter,
        epilog="""
        Ejemplos de uso:
          audit_bot --today             -> Ver rendimiento de hoy
          audit_bot --week --status WIN -> Ver ganancias de la semana
          audit_bot --symbol SOLUSDT    -> Auditar solo SOL
        """
    )
    
    time_group = parser.add_argument_group('⏱️  Filtros de Tiempo')
    time_group.add_argument('--today', action='store_true', help='Operaciones de HOY (00:00 a 23:59 local)')
    time_group.add_argument('--yesterday', action='store_true', help='Operaciones de AYER (00:00 a 23:59 local)')
    time_group.add_argument('--week', action='store_true', help='Operaciones de los últimos 7 días')
    time_group.add_argument('--month', action='store_true', help='Operaciones de los últimos 30 días')
    time_group.add_argument('--days', type=int, metavar='N', help='Operaciones de los últimos N días')
    
    filter_group = parser.add_argument_group('🔍 Filtros de Operación')
    filter_group.add_argument('--symbol', type=str, metavar='SYM', help='Filtrar por par (ej: BTCUSDT, SOL)')
    filter_group.add_argument('--status', type=str, choices=['WIN', 'LOSS'], help='Filtrar por resultado (Ganadoras o Perdedoras)')
    filter_group.add_argument('--side', type=str, choices=['LONG', 'SHORT'], help='Filtrar por dirección del trade')
    
    return parser.parse_args()

def fetch_trade_history():
    print(f"🔄 Conectando a Binance (Inicio: {START_DATE})...", flush=True)
    exchange = ccxt.binance({
        'apiKey': API_KEY,
        'secret': API_SECRET,
        'options': {'defaultType': 'future'},
        'enableRateLimit': True
    })

    since = exchange.parse8601(START_DATE)
    all_trades = []
    
    for symbol in TARGET_SYMBOLS:
        try:
            trades = exchange.fetch_my_trades(symbol, since=since)
            for t in trades:
                t['symbol'] = symbol
                info = t.get('info', {})
                t['realized_pnl'] = float(info.get('realizedPnl', 0))
                t['commission_paid'] = float(info.get('commission', 0))
                t['qty'] = float(t['amount'])
                t['price'] = float(t['price'])
            all_trades.extend(trades)
        except:
            pass 
    return all_trades

def filter_operations(df, args):
    if df.empty: return df
    filtered = df.copy()
    now = datetime.now()
    
    # Asegurar que datetime sea timezone-naive para comparación
    if filtered['datetime'].dt.tz is not None:
        filtered['datetime'] = filtered['datetime'].dt.tz_localize(None)
    
    if args.today:
        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_day = now.replace(hour=23, minute=59, second=59, microsecond=999999)
        filtered = filtered[(filtered['datetime'] >= start_of_day) & (filtered['datetime'] <= end_of_day)]
    elif hasattr(args, 'yesterday') and args.yesterday:
        yesterday = now - timedelta(days=1)
        start_of_yesterday = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_yesterday = yesterday.replace(hour=23, minute=59, second=59, microsecond=999999)
        filtered = filtered[(filtered['datetime'] >= start_of_yesterday) & (filtered['datetime'] <= end_of_yesterday)]
    elif args.week:
        start_week = (now - timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0)
        filtered = filtered[filtered['datetime'] >= start_week]
    elif args.month:
        start_month = (now - timedelta(days=30)).replace(hour=0, minute=0, second=0, microsecond=0)
        filtered = filtered[filtered['datetime'] >= start_month]
    elif args.days:
        start_days = (now - timedelta(days=args.days)).replace(hour=0, minute=0, second=0, microsecond=0)
        filtered = filtered[filtered['datetime'] >= start_days]
        
    if args.symbol:
        sym = args.symbol.upper()
        if '/' not in sym and not sym.endswith('USDT'): sym += 'USDT'
        if '/' not in sym: sym = sym.replace('USDT', '/USDT')
        filtered = filtered[filtered['symbol'] == sym]
        
    if args.side:
        filtered = filtered[filtered['side_type'] == args.side]
        
    if args.status:
        if args.status == 'WIN':
            filtered = filtered[filtered['realized_pnl'] > 0]
        else:
            filtered = filtered[filtered['realized_pnl'] <= 0]
            
    return filtered

def generate_charts(df, output_dir):
    if df.empty: return
    
    plt.figure(figsize=(10, 5))
    df_sorted = df.sort_values('datetime')
    df_sorted['cumulative_pnl'] = df_sorted['realized_pnl'].cumsum()
    sns.lineplot(data=df_sorted, x='datetime', y='cumulative_pnl', marker='o', color='#00ff00')
    plt.title('Curva de Crecimiento (Selección Actual)')
    plt.ylabel('USDT')
    plt.axhline(0, color='white', linestyle='--', alpha=0.3)
    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'chart_equity.png'))
    plt.close()

    plt.figure(figsize=(10, 5))
    pnl_sum = df.groupby('symbol')['realized_pnl'].sum().sort_values()
    if not pnl_sum.empty:
        colors = ['red' if x < 0 else 'green' for x in pnl_sum.values]
        pnl_sum.plot(kind='bar', color=colors)
        plt.title('PnL Neto por Moneda')
        plt.axhline(0, color='white', linewidth=0.5)
        plt.tight_layout()
        plt.savefig(os.path.join(output_dir, 'chart_pnl_symbol.png'))
        plt.close()

def analyze_operations(trades, args):
    if not trades:
        print("❌ Sin datos crudos.")
        return

    df = pd.DataFrame(trades)
    df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms')

    closing_fills = df[df['realized_pnl'] != 0].copy()
    if closing_fills.empty:
        print("⚠️ Sin operaciones cerradas.")
        return

    ops = closing_fills.groupby(['symbol', 'order', 'side']).agg({
        'realized_pnl': 'sum',
        'commission_paid': 'sum',
        'qty': 'sum',
        'price': 'mean', 
        'datetime': 'max'
    }).reset_index()

    def calc_metrics(row):
        pos_side = 'LONG' if row['side'] == 'sell' else 'SHORT'
        entry = row['price'] - (row['realized_pnl'] / row['qty']) if pos_side == 'LONG' else row['price'] + (row['realized_pnl'] / row['qty'])
        roi = 0
        if entry > 0:
            roi = ((row['price'] - entry) / entry) * 100
            if pos_side == 'SHORT': roi *= -1
        return pd.Series([pos_side, entry, roi])

    ops[['side_type', 'entry_price', 'roi_pct']] = ops.apply(calc_metrics, axis=1)
    
    ops_filtered = filter_operations(ops, args)
    ops_filtered = ops_filtered.sort_values('datetime', ascending=False)
    
    if ops_filtered.empty:
        print("\n⚠️ No se encontraron operaciones con los filtros aplicados.")
        return

    net_pnl = ops_filtered['realized_pnl'].sum() - ops_filtered['commission_paid'].sum()
    win_rate = (len(ops_filtered[ops_filtered['realized_pnl'] > 0]) / len(ops_filtered)) * 100

    print(f"\n--- REPORTE FILTRADO ({len(ops_filtered)} ops) ---")
    symbol_counts = ops_filtered['symbol'].value_counts()
    for symbol in TARGET_SYMBOLS:
        count = symbol_counts.get(symbol, 0)
        if count > 0:
            print(f"✅ {symbol}: {count}")
    
    csv_path = os.path.join(PROJECT_ROOT, 'analysis', 'operations_history.csv')
    ops_filtered.to_csv(csv_path, index=False)
    
    charts_dir = os.path.join(PROJECT_ROOT, 'analysis')
    generate_charts(ops_filtered, charts_dir)
    
    print(f"\n💾 CSV Filtrado: {csv_path}")
    print(f"📄 Gráficas: {charts_dir}")
    print(f"💡 Ver detalle: trading_report") # Sugerencia del nuevo comando

    print("\n--- TOTALES (SELECCIÓN) ---")
    print(f"Operaciones: {len(ops_filtered)}")
    print(f"PnL Neto: ${net_pnl:.2f}")
    print(f"Win Rate: {win_rate:.2f}%")

if __name__ == "__main__":
    args = parse_arguments()
    trades = fetch_trade_history()
    analyze_operations(trades, args)
