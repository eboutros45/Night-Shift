// The one source of "now". Services never call Date.now() directly, so tests and the
// dev clock (on /admin/trace) can move time forward to watch holds expire and waves roll.
let offsetMs = 0;

export const now = () => Date.now() + offsetMs;
export const clockOffset = () => offsetMs;
export const advanceClock = (ms: number) => {
  offsetMs += ms;
};
export const resetClock = () => {
  offsetMs = 0;
};
