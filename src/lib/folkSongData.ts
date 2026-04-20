// Folk song data for HarmonyWorkshop
// Organization: Tonality > Metre > Swing
import type { FolkSong } from "@/components/HarmonyWorkshop";

export const FOLK_SONG_LIBRARY: FolkSong[] = [
  // ── Major / Duple / Straight ──
  {
    id:"danny-boy",
    title:"Danny Boy",
    key:"C major",
    timeSignature:"4/4",
    bars:[
      {melody:[{degree:7,duration:0.5},{degree:1,duration:0.5},{degree:2,duration:0.5}],chordRoman:"V"},
      {melody:[{degree:3,duration:1.5},{degree:2,duration:0.5},{degree:3,duration:0.5},{degree:6,duration:0.5},{degree:5,duration:0.5},{degree:3,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:2,duration:0.5},{degree:1,duration:0.5},{degree:6,duration:1.5},{degree:1,duration:0.5},{degree:3,duration:0.5},{degree:4,duration:0.5}],chordRoman:"IV"},
      {melody:[{degree:5,duration:1.5},{degree:6,duration:0.5},{degree:5,duration:0.5},{degree:3,duration:0.5},{degree:1,duration:0.5},{degree:3,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:2,duration:2.0},{degree:7,duration:0.5},{degree:1,duration:0.5},{degree:2,duration:0.5}],chordRoman:"V"},
      {melody:[{degree:3,duration:1.5},{degree:2,duration:0.5},{degree:3,duration:0.5},{degree:6,duration:0.5},{degree:5,duration:0.5},{degree:3,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:2,duration:0.5},{degree:1,duration:0.5},{degree:6,duration:1.5},{degree:7,duration:0.5},{degree:1,duration:0.5},{degree:2,duration:0.5}],chordRoman:"V/V"},
      {melody:[{degree:3,duration:1.5},{degree:4,duration:0.5},{degree:3,duration:0.5},{degree:2,duration:0.5},{degree:1,duration:0.5},{degree:2,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:1,duration:2.0},{degree:5,duration:0.5},{degree:6,duration:0.5},{degree:7,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:1,duration:1.5},{degree:7,duration:0.5},{degree:7,duration:0.5},{degree:6,duration:0.5},{degree:5,duration:0.5},{degree:6,duration:0.5}],chordRoman:"VIm"},
      {melody:[{degree:5,duration:0.5},{degree:3,duration:0.5},{degree:1,duration:1.0},{degree:5,duration:0.5},{degree:6,duration:0.5},{degree:7,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:1,duration:1.5},{degree:7,duration:0.5},{degree:7,duration:0.5},{degree:6,duration:0.5},{degree:5,duration:0.5},{degree:3,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:2,duration:2.0},{degree:5,duration:0.5},{degree:5,duration:0.5},{degree:5,duration:0.5}],chordRoman:"V"},
      {melody:[{degree:3,duration:1.5},{degree:2,duration:0.5},{degree:2,duration:0.5},{degree:1,duration:0.5},{degree:6,duration:0.5},{degree:1,duration:0.5}],chordRoman:"VIm"},
      {melody:[{degree:5,duration:0.5},{degree:3,duration:0.5},{degree:1,duration:1.5},{degree:7,duration:0.5},{degree:1,duration:0.5},{degree:2,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:3,duration:0.5},{degree:6,duration:0.5},{degree:5,duration:0.5},{degree:3,duration:0.5},{degree:2,duration:0.5},{degree:1,duration:0.5},{degree:6,duration:0.5},{degree:7,duration:0.5}],chordRoman:"VIm"},
      {melody:[{degree:1,duration:1.5}],chordRoman:"I"},
    ],
  },
  {
    id:"shenandoah",
    title:"Shenandoah",
    key:"D major",
    timeSignature:"4/4",
    bars:[
      {melody:[{degree:5,duration:1.0}],chordRoman:"I"},
      {melody:[{degree:1,duration:0.5},{degree:1,duration:0.5},{degree:1,duration:1.5},{degree:2,duration:0.5},{degree:3,duration:0.5},{degree:4,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:6,duration:0.5},{degree:5,duration:1.5},{degree:1,duration:0.5},{degree:7,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:6,duration:1.5},{degree:5,duration:0.5},{degree:6,duration:0.5},{degree:5,duration:0.5}],chordRoman:"VIm"},
      {melody:[{degree:3,duration:0.5},{degree:5,duration:1.5},{degree:5,duration:1.0}],chordRoman:"I"},
      {melody:[{degree:6,duration:0.5},{degree:6,duration:0.5},{degree:6,duration:1.5},{degree:3,duration:0.5},{degree:5,duration:0.5},{degree:3,duration:0.5}],chordRoman:"VIm"},
      {melody:[{degree:2,duration:0.5},{degree:1,duration:1.5},{degree:1,duration:0.5},{degree:2,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:3,duration:1.5},{degree:2,duration:0.5},{degree:3,duration:0.75},{degree:6,duration:0.25}],chordRoman:"VIm"},
      {melody:[{degree:5,duration:3.0}],chordRoman:"I"},
      {melody:[{degree:1,duration:0.75},{degree:2,duration:0.25},{degree:3,duration:1.5},{degree:2,duration:0.5}],chordRoman:"I"},
      {melody:[{degree:2,duration:1.0},{degree:1,duration:2.0}],chordRoman:"I"},
    ],
  },
];

export interface FolkSongGroup {
  tonality: string;
  metre: string;
  swing: string;
  label: string;
  count: number;
}

export const FOLK_SONG_GROUPS: FolkSongGroup[] = [
  {tonality:"Major",metre:"Duple",swing:"Straight",label:"Major / Duple / Straight",count:2},
];
