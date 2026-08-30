from pathlib import Path

path = Path('src/app/services/TradingService.ts')
text = path.read_text()

anchor = "import { AegisRealtimeMarketState } from '../../strategies/aegis/application/AegisRealtimeMarketState';\n"
addition = anchor + "import {\n  extractAegisPhaseOMetadata,\n  type AegisPhaseOMetadata,\n} from '../../strategies/aegis/application/AegisPhaseOMetadataParser';\n"
if 'AegisPhaseOMetadataParser' not in text:
    if anchor not in text:
        raise SystemExit('import anchor missing')
    text = text.replace(anchor, addition, 1)

old_type = '''type PhaseOTurboMetadata = {
  isPhaseO: boolean;
  side: Side | null;
  entryEnabled: boolean;
  avoidOnly: boolean;
  modelFamily?: string;
  symbol?: string;
  sourcePath: string;
  raw?: Record<string, unknown>;
};

'''
if old_type in text:
    text = text.replace(old_type, '', 1)

start = text.find('  private asRecord(value: unknown): Record<string, any> | undefined {')
end = text.find('  private isPhaseOShortLiveSignal(signal: AegisTradingSignal, side: Side): boolean {', start)
if start < 0 or end < 0:
    raise SystemExit('Phase O parser block anchors missing')
wrapper = '''  private extractPhaseOTurboMetadata(
    signalOrPrediction: unknown,
    fallbackSide?: Side,
  ): AegisPhaseOMetadata | null {
    return extractAegisPhaseOMetadata(signalOrPrediction, fallbackSide);
  }

'''
text = text[:start] + wrapper + text[end:]
path.write_text(text)
