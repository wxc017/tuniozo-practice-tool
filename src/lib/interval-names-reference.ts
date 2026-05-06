// ── Extended-diatonic interval naming reference ─────────────────────────
// Source: SKU (short-form / long-form) interval naming system
// Stored here for future EDO support. Only 31 and 41 are active in edoData.ts.

// ── Full nomenclature table ──
// Short   Long                                           JI
// P1      perfect unison                                 1/1
// K1      komma-wide unison                              81/80
// S1      super unison                                   64/63
// U1      uber unison                                    33/32
// kA1     komma-narrow augmented unison                  135/128
// A1      augmented unison                               2187/2048
// SA1     super augmented unison                         243/224
// sm2     subminor second                                28/27
// m2      minor second                                   256/243
// Km2     klassisch minor second                         16/15
// Um2/n2  uber minor second / lesser neutral second      88/81
// uM2/n2  unter major second / greater neutral second    12/11
// kM2     klassisch major second                         10/9
// M2      major second                                   9/8
// SM2     supermajor second                              8/7
// sm3     subminor third                                 7/6
// m3      minor third                                    32/27
// Km3     klassisch minor third                          6/5
// Um3/n3  uber minor third / lesser neutral third        11/9
// uM3/n3  unter major third / greater neutral third      27/22
// kM3     klassisch major third                          5/4
// M3      major third                                    81/64
// SM3     supermajor third                               9/7
// s4      sub fourth                                     21/16
// P4      perfect fourth                                 4/3
// K4      komma-wide fourth                              27/20
// U4      uber fourth                                    11/8
// uA4     unter augmented fourth                         243/176
// kA4     komma-narrow augmented fourth                  45/32
// A4      augmented fourth                               729/512
// SA4     super augmented fourth                         81/56
// sd5     sub diminished fifth                           112/81
// d5      diminished fifth                               1024/729
// Kd5     komma-wide diminished fifth                    64/45
// Ud5     uber diminished fifth                          352/243
// u5      unter fifth                                    16/11
// k5      komma-narrow fifth                             40/27
// P5      perfect fifth                                  3/2
// S5      super fifth                                    32/21
// sm6     subminor sixth                                 14/9
// m6      minor sixth                                    128/81
// Km6     klassisch minor sixth                          8/5
// Um6/n6  uber minor sixth / lesser neutral sixth        44/27
// uM6/n6  unter major sixth / greater neutral sixth      18/11
// kM6     klassisch major sixth                          5/3
// M6      major sixth                                    27/16
// SM6     supermajor sixth                               12/7
// sm7     subminor seventh                               7/4
// m7      minor seventh                                  16/9
// Km7     klassisch minor seventh                        9/5
// Um7/n7  uber minor seventh / lesser neutral seventh    11/6
// uM7/n7  unter major seventh / greater neutral seventh  81/44
// kM7     klassisch major seventh                        15/8
// M7      major seventh                                  243/128
// SM7     supermajor seventh                             27/14
// sd8     sub diminished octave                          448/243
// d8      diminished octave                              4096/2187
// Kd8     komma-wide diminished octave                   256/135
// u8      unter octave                                   64/33
// s8      sub octave                                     63/32
// k8      komma-narrow octave                            160/81
// P8      perfect octave                                 2/1

// ── Per-EDO interval sequences (not yet active) ──

// 24-EDO
// P1 S1/U1/sm2 m2 n2 M2 SM2/sm3 m3 n3 M3 SM3/s4 P4 U4 A4/d5 u5 P5 S5/sm6 m6 n6 M6 SM6/sm7 m7 n7 M7 SM7/u8/s8 P8

// 27-EDO (using 27e mapping)
// P1 K1/m2 U1/Km2 n2 kM2 M2 m3 Km3 n3 kM3 M3 P4 K4/d5 U4/Kd5 kA4/u5 A4/k5 P5 m6 Km6 n6 kM6 M6 m7 Km7 n7 kM7/u8 M7/k8 P8

// 29-EDO
// P1 K1/S1/sm2 m2 Km2 kM2 M2 SM2/sm3 m3 Km3 kM3 M3 SM3/s4 P4 K4 kA4/d5 A4/Kd5 k5 P5 S5/sm6 m6 Km6 kM6 M6 SM6/sm7 m7 Km7 kM7 M7 SM7/S8/k8 P8

// 34-EDO
// P1 K1/S1/sm2 m2 Km2 n2 kM2 M2 SM2/sm3 m3 Km3 n3 kM3 M3 SM3/s4 P4 K4 U4/d5 kA4/Kd5 A4/u5 k5 P5 S5/sm6 m6 Km6 n6 kM6 M6 SM6/sm7 m7 Km7 n7 kM7 M7 SM7/k8/s8 P8

// 38-EDO (chromatic names needed)
// P1 S1 A1 sm2 m2 n2 M2 SM2 A2/d3 sm3 m3 n3 M3 SM3 d4 s4 P4 U4 A4 SA4/sd5 d5 u5 P5 S5 A5 sm6 m6 n6 M6 SM6 A6/d7 sm7 m7 n7 M7 SM7 d8 s8 P8

// 45-EDO (chromatic names needed)
// P1 S1/U1 uA1 A1 sm2 m2 n2 n2 M2 SM2 A2/d3 sm3 m3 n3 n3 M3 SM3 d4 s4 P4 U4 A4 SA4 sd5 d5 u5 P5 S5 A5 sm6 m6 n6 n6 M6 SM6 A6/d7 sm7 m7 n7 n7 M7 SM7 d8 Ud8 s8/u8 P8

// 46-EDO
// P1 K1/S1 U1/sm2 m2 Km2 n2 n2 kM2 M2 SM2 sm3 m3 Km3 n3 n3 kM3 M3 SM3 s4 P4 K4 U4 uA4/d5 kA4/Kd5 A4/Ud5 SA4/u5 k5 P5 S5 sm6 m6 Km6 n6 n6 kM6 M6 SM6 sm7 m7 Km7 n7 n7 kM7 M7 SM7/u8 k8/s8 P8
