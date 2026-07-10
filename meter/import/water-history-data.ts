/**
 * Historical water-meter data (Issue #792), extracted from the Dropbox Excel
 * sheet "Zählerstände Wasser - Strom.xlsx" (sheet "Verbrauch", columns A:C).
 *
 * Generated once from the uploaded export and slimmed to the fields the
 * importer needs. Embedded as a TS module (not a JSON asset read at runtime)
 * so it is bundled deterministically by the Encore build. See
 * import-water-history.ts for the semantics.
 *
 * DO NOT hand-edit — replace wholesale if the source sheet changes.
 */

import type { WaterImportData } from "../import-water-history";

export const waterHistoryData: WaterImportData = {
  "metadata": {
    "unit": "m3"
  },
  "meter_change_events": [
    {
      "date": "2013-01-01",
      "new_meter_index": 2,
      "previous_meter_final_reading_m3": 495
    },
    {
      "date": "2018-11-01",
      "new_meter_index": 3,
      "previous_meter_final_reading_m3": 519.9
    },
    {
      "date": "2024-05-01",
      "new_meter_index": 4,
      "previous_meter_final_reading_m3": 583.9
    }
  ],
  "readings": [
    {
      "date": "2008-01-01",
      "meter_reading_m3": 92,
      "cumulative_meter_reading_m3": 92,
      "meter_index": 1
    },
    {
      "date": "2008-02-13",
      "meter_reading_m3": 101.5,
      "cumulative_meter_reading_m3": 101.5,
      "meter_index": 1
    },
    {
      "date": "2008-02-25",
      "meter_reading_m3": 104,
      "cumulative_meter_reading_m3": 104,
      "meter_index": 1
    },
    {
      "date": "2008-03-06",
      "meter_reading_m3": 106.1,
      "cumulative_meter_reading_m3": 106.1,
      "meter_index": 1
    },
    {
      "date": "2008-03-28",
      "meter_reading_m3": 111.7,
      "cumulative_meter_reading_m3": 111.7,
      "meter_index": 1
    },
    {
      "date": "2008-04-03",
      "meter_reading_m3": 113.1,
      "cumulative_meter_reading_m3": 113.1,
      "meter_index": 1
    },
    {
      "date": "2008-05-02",
      "meter_reading_m3": 119.7,
      "cumulative_meter_reading_m3": 119.7,
      "meter_index": 1
    },
    {
      "date": "2008-06-15",
      "meter_reading_m3": 129.7,
      "cumulative_meter_reading_m3": 129.7,
      "meter_index": 1
    },
    {
      "date": "2008-07-01",
      "meter_reading_m3": 133.7,
      "cumulative_meter_reading_m3": 133.7,
      "meter_index": 1
    },
    {
      "date": "2008-08-02",
      "meter_reading_m3": 141.5,
      "cumulative_meter_reading_m3": 141.5,
      "meter_index": 1
    },
    {
      "date": "2008-09-02",
      "meter_reading_m3": 148.6,
      "cumulative_meter_reading_m3": 148.6,
      "meter_index": 1
    },
    {
      "date": "2008-10-01",
      "meter_reading_m3": 154.8,
      "cumulative_meter_reading_m3": 154.8,
      "meter_index": 1
    },
    {
      "date": "2008-11-02",
      "meter_reading_m3": 162.9,
      "cumulative_meter_reading_m3": 162.9,
      "meter_index": 1
    },
    {
      "date": "2008-12-04",
      "meter_reading_m3": 168.8,
      "cumulative_meter_reading_m3": 168.8,
      "meter_index": 1
    },
    {
      "date": "2009-01-01",
      "meter_reading_m3": 175.2,
      "cumulative_meter_reading_m3": 175.2,
      "meter_index": 1
    },
    {
      "date": "2009-02-01",
      "meter_reading_m3": 182,
      "cumulative_meter_reading_m3": 182,
      "meter_index": 1
    },
    {
      "date": "2009-03-01",
      "meter_reading_m3": 188.2,
      "cumulative_meter_reading_m3": 188.2,
      "meter_index": 1
    },
    {
      "date": "2009-04-02",
      "meter_reading_m3": 194.5,
      "cumulative_meter_reading_m3": 194.5,
      "meter_index": 1
    },
    {
      "date": "2009-05-01",
      "meter_reading_m3": 201,
      "cumulative_meter_reading_m3": 201,
      "meter_index": 1
    },
    {
      "date": "2009-06-01",
      "meter_reading_m3": 208.3,
      "cumulative_meter_reading_m3": 208.3,
      "meter_index": 1
    },
    {
      "date": "2009-07-03",
      "meter_reading_m3": 215.7,
      "cumulative_meter_reading_m3": 215.7,
      "meter_index": 1
    },
    {
      "date": "2009-08-01",
      "meter_reading_m3": 222.2,
      "cumulative_meter_reading_m3": 222.2,
      "meter_index": 1
    },
    {
      "date": "2009-09-01",
      "meter_reading_m3": 230,
      "cumulative_meter_reading_m3": 230,
      "meter_index": 1
    },
    {
      "date": "2009-10-01",
      "meter_reading_m3": 236,
      "cumulative_meter_reading_m3": 236,
      "meter_index": 1
    },
    {
      "date": "2009-11-01",
      "meter_reading_m3": 242.2,
      "cumulative_meter_reading_m3": 242.2,
      "meter_index": 1
    },
    {
      "date": "2009-12-01",
      "meter_reading_m3": 248.6,
      "cumulative_meter_reading_m3": 248.6,
      "meter_index": 1
    },
    {
      "date": "2010-01-01",
      "meter_reading_m3": 255.8,
      "cumulative_meter_reading_m3": 255.8,
      "meter_index": 1
    },
    {
      "date": "2010-02-01",
      "meter_reading_m3": 262.5,
      "cumulative_meter_reading_m3": 262.5,
      "meter_index": 1
    },
    {
      "date": "2010-03-01",
      "meter_reading_m3": 268.3,
      "cumulative_meter_reading_m3": 268.3,
      "meter_index": 1
    },
    {
      "date": "2010-04-01",
      "meter_reading_m3": 275,
      "cumulative_meter_reading_m3": 275,
      "meter_index": 1
    },
    {
      "date": "2010-05-01",
      "meter_reading_m3": 282,
      "cumulative_meter_reading_m3": 282,
      "meter_index": 1
    },
    {
      "date": "2010-06-01",
      "meter_reading_m3": 288.7,
      "cumulative_meter_reading_m3": 288.7,
      "meter_index": 1
    },
    {
      "date": "2010-07-01",
      "meter_reading_m3": 295.3,
      "cumulative_meter_reading_m3": 295.3,
      "meter_index": 1
    },
    {
      "date": "2010-08-01",
      "meter_reading_m3": 302.1,
      "cumulative_meter_reading_m3": 302.1,
      "meter_index": 1
    },
    {
      "date": "2010-09-01",
      "meter_reading_m3": 310,
      "cumulative_meter_reading_m3": 310,
      "meter_index": 1
    },
    {
      "date": "2010-10-01",
      "meter_reading_m3": 316.2,
      "cumulative_meter_reading_m3": 316.2,
      "meter_index": 1
    },
    {
      "date": "2010-11-01",
      "meter_reading_m3": 323.4,
      "cumulative_meter_reading_m3": 323.4,
      "meter_index": 1
    },
    {
      "date": "2010-12-01",
      "meter_reading_m3": 328.9,
      "cumulative_meter_reading_m3": 328.9,
      "meter_index": 1
    },
    {
      "date": "2011-01-01",
      "meter_reading_m3": 335.2,
      "cumulative_meter_reading_m3": 335.2,
      "meter_index": 1
    },
    {
      "date": "2011-02-01",
      "meter_reading_m3": 341.2,
      "cumulative_meter_reading_m3": 341.2,
      "meter_index": 1
    },
    {
      "date": "2011-03-03",
      "meter_reading_m3": 347.3,
      "cumulative_meter_reading_m3": 347.3,
      "meter_index": 1
    },
    {
      "date": "2011-04-01",
      "meter_reading_m3": 353.5,
      "cumulative_meter_reading_m3": 353.5,
      "meter_index": 1
    },
    {
      "date": "2011-05-01",
      "meter_reading_m3": 360.3,
      "cumulative_meter_reading_m3": 360.3,
      "meter_index": 1
    },
    {
      "date": "2011-06-01",
      "meter_reading_m3": 367.5,
      "cumulative_meter_reading_m3": 367.5,
      "meter_index": 1
    },
    {
      "date": "2011-07-01",
      "meter_reading_m3": 374.3,
      "cumulative_meter_reading_m3": 374.3,
      "meter_index": 1
    },
    {
      "date": "2011-08-06",
      "meter_reading_m3": 383.3,
      "cumulative_meter_reading_m3": 383.3,
      "meter_index": 1
    },
    {
      "date": "2011-10-01",
      "meter_reading_m3": 397.5,
      "cumulative_meter_reading_m3": 397.5,
      "meter_index": 1
    },
    {
      "date": "2011-11-01",
      "meter_reading_m3": 405,
      "cumulative_meter_reading_m3": 405,
      "meter_index": 1
    },
    {
      "date": "2011-12-01",
      "meter_reading_m3": 410,
      "cumulative_meter_reading_m3": 410,
      "meter_index": 1
    },
    {
      "date": "2012-01-01",
      "meter_reading_m3": 417.2,
      "cumulative_meter_reading_m3": 417.2,
      "meter_index": 1
    },
    {
      "date": "2012-02-01",
      "meter_reading_m3": 423.9,
      "cumulative_meter_reading_m3": 423.9,
      "meter_index": 1
    },
    {
      "date": "2012-03-01",
      "meter_reading_m3": 430.3,
      "cumulative_meter_reading_m3": 430.3,
      "meter_index": 1
    },
    {
      "date": "2012-04-01",
      "meter_reading_m3": 436.9,
      "cumulative_meter_reading_m3": 436.9,
      "meter_index": 1
    },
    {
      "date": "2012-05-01",
      "meter_reading_m3": 444.6,
      "cumulative_meter_reading_m3": 444.6,
      "meter_index": 1
    },
    {
      "date": "2012-06-01",
      "meter_reading_m3": 452.4,
      "cumulative_meter_reading_m3": 452.4,
      "meter_index": 1
    },
    {
      "date": "2012-07-01",
      "meter_reading_m3": 460.3,
      "cumulative_meter_reading_m3": 460.3,
      "meter_index": 1
    },
    {
      "date": "2012-08-01",
      "meter_reading_m3": 468.9,
      "cumulative_meter_reading_m3": 468.9,
      "meter_index": 1
    },
    {
      "date": "2012-09-01",
      "meter_reading_m3": 474.6,
      "cumulative_meter_reading_m3": 474.6,
      "meter_index": 1
    },
    {
      "date": "2012-10-01",
      "meter_reading_m3": 479.8,
      "cumulative_meter_reading_m3": 479.8,
      "meter_index": 1
    },
    {
      "date": "2012-11-01",
      "meter_reading_m3": 487.4,
      "cumulative_meter_reading_m3": 487.4,
      "meter_index": 1
    },
    {
      "date": "2012-12-01",
      "meter_reading_m3": 494,
      "cumulative_meter_reading_m3": 494,
      "meter_index": 1
    },
    {
      "date": "2013-01-01",
      "meter_reading_m3": 6.3,
      "cumulative_meter_reading_m3": 501.3,
      "meter_index": 2
    },
    {
      "date": "2013-02-01",
      "meter_reading_m3": 14,
      "cumulative_meter_reading_m3": 509,
      "meter_index": 2
    },
    {
      "date": "2013-03-01",
      "meter_reading_m3": 21.5,
      "cumulative_meter_reading_m3": 516.5,
      "meter_index": 2
    },
    {
      "date": "2013-04-01",
      "meter_reading_m3": 28.5,
      "cumulative_meter_reading_m3": 523.5,
      "meter_index": 2
    },
    {
      "date": "2013-05-01",
      "meter_reading_m3": 35.2,
      "cumulative_meter_reading_m3": 530.2,
      "meter_index": 2
    },
    {
      "date": "2013-06-01",
      "meter_reading_m3": 42,
      "cumulative_meter_reading_m3": 537,
      "meter_index": 2
    },
    {
      "date": "2013-07-01",
      "meter_reading_m3": 50,
      "cumulative_meter_reading_m3": 545,
      "meter_index": 2
    },
    {
      "date": "2013-08-01",
      "meter_reading_m3": 57.6,
      "cumulative_meter_reading_m3": 552.6,
      "meter_index": 2
    },
    {
      "date": "2013-09-01",
      "meter_reading_m3": 66,
      "cumulative_meter_reading_m3": 561,
      "meter_index": 2
    },
    {
      "date": "2013-10-01",
      "meter_reading_m3": 71.3,
      "cumulative_meter_reading_m3": 566.3,
      "meter_index": 2
    },
    {
      "date": "2013-11-01",
      "meter_reading_m3": 78.6,
      "cumulative_meter_reading_m3": 573.6,
      "meter_index": 2
    },
    {
      "date": "2013-12-01",
      "meter_reading_m3": 84.6,
      "cumulative_meter_reading_m3": 579.6,
      "meter_index": 2
    },
    {
      "date": "2014-01-01",
      "meter_reading_m3": 91.4,
      "cumulative_meter_reading_m3": 586.4,
      "meter_index": 2
    },
    {
      "date": "2014-02-01",
      "meter_reading_m3": 98.5,
      "cumulative_meter_reading_m3": 593.5,
      "meter_index": 2
    },
    {
      "date": "2014-03-01",
      "meter_reading_m3": 104,
      "cumulative_meter_reading_m3": 599,
      "meter_index": 2
    },
    {
      "date": "2014-04-01",
      "meter_reading_m3": 110.1,
      "cumulative_meter_reading_m3": 605.1,
      "meter_index": 2
    },
    {
      "date": "2014-05-01",
      "meter_reading_m3": 116.8,
      "cumulative_meter_reading_m3": 611.8,
      "meter_index": 2
    },
    {
      "date": "2014-06-01",
      "meter_reading_m3": 123.5,
      "cumulative_meter_reading_m3": 618.5,
      "meter_index": 2
    },
    {
      "date": "2014-07-01",
      "meter_reading_m3": 130.2,
      "cumulative_meter_reading_m3": 625.2,
      "meter_index": 2
    },
    {
      "date": "2014-08-01",
      "meter_reading_m3": 137.5,
      "cumulative_meter_reading_m3": 632.5,
      "meter_index": 2
    },
    {
      "date": "2014-09-01",
      "meter_reading_m3": 145,
      "cumulative_meter_reading_m3": 640,
      "meter_index": 2
    },
    {
      "date": "2014-10-01",
      "meter_reading_m3": 150.9,
      "cumulative_meter_reading_m3": 645.9,
      "meter_index": 2
    },
    {
      "date": "2014-11-01",
      "meter_reading_m3": 157,
      "cumulative_meter_reading_m3": 652,
      "meter_index": 2
    },
    {
      "date": "2014-12-01",
      "meter_reading_m3": 164,
      "cumulative_meter_reading_m3": 659,
      "meter_index": 2
    },
    {
      "date": "2015-01-01",
      "meter_reading_m3": 171.4,
      "cumulative_meter_reading_m3": 666.4,
      "meter_index": 2
    },
    {
      "date": "2015-02-01",
      "meter_reading_m3": 178,
      "cumulative_meter_reading_m3": 673,
      "meter_index": 2
    },
    {
      "date": "2015-03-01",
      "meter_reading_m3": 184.2,
      "cumulative_meter_reading_m3": 679.2,
      "meter_index": 2
    },
    {
      "date": "2015-04-01",
      "meter_reading_m3": 192.1,
      "cumulative_meter_reading_m3": 687.1,
      "meter_index": 2
    },
    {
      "date": "2015-05-01",
      "meter_reading_m3": 199,
      "cumulative_meter_reading_m3": 694,
      "meter_index": 2
    },
    {
      "date": "2015-06-06",
      "meter_reading_m3": 205.8,
      "cumulative_meter_reading_m3": 700.8,
      "meter_index": 2
    },
    {
      "date": "2015-07-01",
      "meter_reading_m3": 211.8,
      "cumulative_meter_reading_m3": 706.8,
      "meter_index": 2
    },
    {
      "date": "2015-08-01",
      "meter_reading_m3": 219,
      "cumulative_meter_reading_m3": 714,
      "meter_index": 2
    },
    {
      "date": "2015-09-01",
      "meter_reading_m3": 226.5,
      "cumulative_meter_reading_m3": 721.5,
      "meter_index": 2
    },
    {
      "date": "2015-10-01",
      "meter_reading_m3": 233.2,
      "cumulative_meter_reading_m3": 728.2,
      "meter_index": 2
    },
    {
      "date": "2015-11-01",
      "meter_reading_m3": 240,
      "cumulative_meter_reading_m3": 735,
      "meter_index": 2
    },
    {
      "date": "2015-12-01",
      "meter_reading_m3": 246.3,
      "cumulative_meter_reading_m3": 741.3,
      "meter_index": 2
    },
    {
      "date": "2016-01-01",
      "meter_reading_m3": 253.7,
      "cumulative_meter_reading_m3": 748.7,
      "meter_index": 2
    },
    {
      "date": "2016-02-01",
      "meter_reading_m3": 261.4,
      "cumulative_meter_reading_m3": 756.4,
      "meter_index": 2
    },
    {
      "date": "2016-03-01",
      "meter_reading_m3": 268,
      "cumulative_meter_reading_m3": 763,
      "meter_index": 2
    },
    {
      "date": "2016-04-01",
      "meter_reading_m3": 276,
      "cumulative_meter_reading_m3": 771,
      "meter_index": 2
    },
    {
      "date": "2016-05-01",
      "meter_reading_m3": 283,
      "cumulative_meter_reading_m3": 778,
      "meter_index": 2
    },
    {
      "date": "2016-06-01",
      "meter_reading_m3": 290.8,
      "cumulative_meter_reading_m3": 785.8,
      "meter_index": 2
    },
    {
      "date": "2016-07-01",
      "meter_reading_m3": 298,
      "cumulative_meter_reading_m3": 793,
      "meter_index": 2
    },
    {
      "date": "2016-08-01",
      "meter_reading_m3": 306.2,
      "cumulative_meter_reading_m3": 801.2,
      "meter_index": 2
    },
    {
      "date": "2016-09-01",
      "meter_reading_m3": 314,
      "cumulative_meter_reading_m3": 809,
      "meter_index": 2
    },
    {
      "date": "2016-10-01",
      "meter_reading_m3": 320.3,
      "cumulative_meter_reading_m3": 815.3,
      "meter_index": 2
    },
    {
      "date": "2016-11-01",
      "meter_reading_m3": 328,
      "cumulative_meter_reading_m3": 823,
      "meter_index": 2
    },
    {
      "date": "2016-12-01",
      "meter_reading_m3": 335.6,
      "cumulative_meter_reading_m3": 830.6,
      "meter_index": 2
    },
    {
      "date": "2017-01-01",
      "meter_reading_m3": 344,
      "cumulative_meter_reading_m3": 839,
      "meter_index": 2
    },
    {
      "date": "2017-02-01",
      "meter_reading_m3": 352,
      "cumulative_meter_reading_m3": 847,
      "meter_index": 2
    },
    {
      "date": "2017-03-01",
      "meter_reading_m3": 360,
      "cumulative_meter_reading_m3": 855,
      "meter_index": 2
    },
    {
      "date": "2017-04-01",
      "meter_reading_m3": 370,
      "cumulative_meter_reading_m3": 865,
      "meter_index": 2
    },
    {
      "date": "2017-05-01",
      "meter_reading_m3": 379,
      "cumulative_meter_reading_m3": 874,
      "meter_index": 2
    },
    {
      "date": "2017-06-01",
      "meter_reading_m3": 388,
      "cumulative_meter_reading_m3": 883,
      "meter_index": 2
    },
    {
      "date": "2017-07-01",
      "meter_reading_m3": 395,
      "cumulative_meter_reading_m3": 890,
      "meter_index": 2
    },
    {
      "date": "2017-08-01",
      "meter_reading_m3": 403,
      "cumulative_meter_reading_m3": 898,
      "meter_index": 2
    },
    {
      "date": "2017-09-01",
      "meter_reading_m3": 411.9,
      "cumulative_meter_reading_m3": 906.9,
      "meter_index": 2
    },
    {
      "date": "2017-10-01",
      "meter_reading_m3": 418,
      "cumulative_meter_reading_m3": 913,
      "meter_index": 2
    },
    {
      "date": "2017-11-01",
      "meter_reading_m3": 426,
      "cumulative_meter_reading_m3": 921,
      "meter_index": 2
    },
    {
      "date": "2017-12-01",
      "meter_reading_m3": 433.2,
      "cumulative_meter_reading_m3": 928.2,
      "meter_index": 2
    },
    {
      "date": "2018-01-01",
      "meter_reading_m3": 442,
      "cumulative_meter_reading_m3": 937,
      "meter_index": 2
    },
    {
      "date": "2018-02-01",
      "meter_reading_m3": 450,
      "cumulative_meter_reading_m3": 945,
      "meter_index": 2
    },
    {
      "date": "2018-03-01",
      "meter_reading_m3": 456.9,
      "cumulative_meter_reading_m3": 951.9,
      "meter_index": 2
    },
    {
      "date": "2018-04-01",
      "meter_reading_m3": 465.7,
      "cumulative_meter_reading_m3": 960.7,
      "meter_index": 2
    },
    {
      "date": "2018-05-01",
      "meter_reading_m3": 473,
      "cumulative_meter_reading_m3": 968,
      "meter_index": 2
    },
    {
      "date": "2018-06-01",
      "meter_reading_m3": 481,
      "cumulative_meter_reading_m3": 976,
      "meter_index": 2
    },
    {
      "date": "2018-07-01",
      "meter_reading_m3": 490,
      "cumulative_meter_reading_m3": 985,
      "meter_index": 2
    },
    {
      "date": "2018-08-01",
      "meter_reading_m3": 498.2,
      "cumulative_meter_reading_m3": 993.2,
      "meter_index": 2
    },
    {
      "date": "2018-09-01",
      "meter_reading_m3": 508,
      "cumulative_meter_reading_m3": 1003,
      "meter_index": 2
    },
    {
      "date": "2018-10-01",
      "meter_reading_m3": 515.7,
      "cumulative_meter_reading_m3": 1010.7,
      "meter_index": 2
    },
    {
      "date": "2018-11-01",
      "meter_reading_m3": 5.8,
      "cumulative_meter_reading_m3": 1020.7,
      "meter_index": 3
    },
    {
      "date": "2018-12-01",
      "meter_reading_m3": 13,
      "cumulative_meter_reading_m3": 1027.9,
      "meter_index": 3
    },
    {
      "date": "2019-01-01",
      "meter_reading_m3": 21.5,
      "cumulative_meter_reading_m3": 1036.4,
      "meter_index": 3
    },
    {
      "date": "2019-02-01",
      "meter_reading_m3": 29.3,
      "cumulative_meter_reading_m3": 1044.2,
      "meter_index": 3
    },
    {
      "date": "2019-03-01",
      "meter_reading_m3": 36.3,
      "cumulative_meter_reading_m3": 1051.2,
      "meter_index": 3
    },
    {
      "date": "2019-04-01",
      "meter_reading_m3": 44.7,
      "cumulative_meter_reading_m3": 1059.6,
      "meter_index": 3
    },
    {
      "date": "2019-05-01",
      "meter_reading_m3": 53.1,
      "cumulative_meter_reading_m3": 1068,
      "meter_index": 3
    },
    {
      "date": "2019-06-01",
      "meter_reading_m3": 61.7,
      "cumulative_meter_reading_m3": 1076.6,
      "meter_index": 3
    },
    {
      "date": "2019-07-01",
      "meter_reading_m3": 69.4,
      "cumulative_meter_reading_m3": 1084.3,
      "meter_index": 3
    },
    {
      "date": "2019-08-01",
      "meter_reading_m3": 78.6,
      "cumulative_meter_reading_m3": 1093.5,
      "meter_index": 3
    },
    {
      "date": "2019-09-01",
      "meter_reading_m3": 85.8,
      "cumulative_meter_reading_m3": 1100.7,
      "meter_index": 3
    },
    {
      "date": "2019-10-01",
      "meter_reading_m3": 93.7,
      "cumulative_meter_reading_m3": 1108.6,
      "meter_index": 3
    },
    {
      "date": "2019-11-01",
      "meter_reading_m3": 102.5,
      "cumulative_meter_reading_m3": 1117.4,
      "meter_index": 3
    },
    {
      "date": "2019-12-01",
      "meter_reading_m3": 110.9,
      "cumulative_meter_reading_m3": 1125.8,
      "meter_index": 3
    },
    {
      "date": "2020-01-01",
      "meter_reading_m3": 119.3,
      "cumulative_meter_reading_m3": 1134.2,
      "meter_index": 3
    },
    {
      "date": "2020-02-01",
      "meter_reading_m3": 127.5,
      "cumulative_meter_reading_m3": 1142.4,
      "meter_index": 3
    },
    {
      "date": "2020-03-01",
      "meter_reading_m3": 135.6,
      "cumulative_meter_reading_m3": 1150.5,
      "meter_index": 3
    },
    {
      "date": "2020-04-01",
      "meter_reading_m3": 144.5,
      "cumulative_meter_reading_m3": 1159.4,
      "meter_index": 3
    },
    {
      "date": "2020-05-01",
      "meter_reading_m3": 152.8,
      "cumulative_meter_reading_m3": 1167.7,
      "meter_index": 3
    },
    {
      "date": "2020-06-01",
      "meter_reading_m3": 162.9,
      "cumulative_meter_reading_m3": 1177.8,
      "meter_index": 3
    },
    {
      "date": "2020-07-01",
      "meter_reading_m3": 171.5,
      "cumulative_meter_reading_m3": 1186.4,
      "meter_index": 3
    },
    {
      "date": "2020-08-01",
      "meter_reading_m3": 181.9,
      "cumulative_meter_reading_m3": 1196.8,
      "meter_index": 3
    },
    {
      "date": "2020-09-01",
      "meter_reading_m3": 191,
      "cumulative_meter_reading_m3": 1205.9,
      "meter_index": 3
    },
    {
      "date": "2020-10-01",
      "meter_reading_m3": 200,
      "cumulative_meter_reading_m3": 1214.9,
      "meter_index": 3
    },
    {
      "date": "2020-11-01",
      "meter_reading_m3": 201,
      "cumulative_meter_reading_m3": 1215.9,
      "meter_index": 3
    },
    {
      "date": "2020-12-01",
      "meter_reading_m3": 218.3,
      "cumulative_meter_reading_m3": 1233.2,
      "meter_index": 3
    },
    {
      "date": "2021-01-01",
      "meter_reading_m3": 228,
      "cumulative_meter_reading_m3": 1242.9,
      "meter_index": 3
    },
    {
      "date": "2021-02-01",
      "meter_reading_m3": 238,
      "cumulative_meter_reading_m3": 1252.9,
      "meter_index": 3
    },
    {
      "date": "2021-03-01",
      "meter_reading_m3": 247.9,
      "cumulative_meter_reading_m3": 1262.8,
      "meter_index": 3
    },
    {
      "date": "2021-04-01",
      "meter_reading_m3": 256.3,
      "cumulative_meter_reading_m3": 1271.2,
      "meter_index": 3
    },
    {
      "date": "2021-05-01",
      "meter_reading_m3": 266.2,
      "cumulative_meter_reading_m3": 1281.1,
      "meter_index": 3
    },
    {
      "date": "2021-06-01",
      "meter_reading_m3": 275.4,
      "cumulative_meter_reading_m3": 1290.3,
      "meter_index": 3
    },
    {
      "date": "2021-07-01",
      "meter_reading_m3": 285,
      "cumulative_meter_reading_m3": 1299.9,
      "meter_index": 3
    },
    {
      "date": "2021-08-01",
      "meter_reading_m3": 295,
      "cumulative_meter_reading_m3": 1309.9,
      "meter_index": 3
    },
    {
      "date": "2021-09-01",
      "meter_reading_m3": 304,
      "cumulative_meter_reading_m3": 1318.9,
      "meter_index": 3
    },
    {
      "date": "2021-10-01",
      "meter_reading_m3": 311.67,
      "cumulative_meter_reading_m3": 1326.57,
      "meter_index": 3
    },
    {
      "date": "2021-11-01",
      "meter_reading_m3": 322,
      "cumulative_meter_reading_m3": 1336.9,
      "meter_index": 3
    },
    {
      "date": "2021-12-01",
      "meter_reading_m3": 331,
      "cumulative_meter_reading_m3": 1345.9,
      "meter_index": 3
    },
    {
      "date": "2022-01-01",
      "meter_reading_m3": 341,
      "cumulative_meter_reading_m3": 1355.9,
      "meter_index": 3
    },
    {
      "date": "2022-02-01",
      "meter_reading_m3": 351,
      "cumulative_meter_reading_m3": 1365.9,
      "meter_index": 3
    },
    {
      "date": "2022-03-01",
      "meter_reading_m3": 360.3,
      "cumulative_meter_reading_m3": 1375.2,
      "meter_index": 3
    },
    {
      "date": "2022-04-01",
      "meter_reading_m3": 371,
      "cumulative_meter_reading_m3": 1385.9,
      "meter_index": 3
    },
    {
      "date": "2022-05-01",
      "meter_reading_m3": 380,
      "cumulative_meter_reading_m3": 1394.9,
      "meter_index": 3
    },
    {
      "date": "2022-06-01",
      "meter_reading_m3": 390,
      "cumulative_meter_reading_m3": 1404.9,
      "meter_index": 3
    },
    {
      "date": "2022-07-01",
      "meter_reading_m3": 399,
      "cumulative_meter_reading_m3": 1413.9,
      "meter_index": 3
    },
    {
      "date": "2022-08-01",
      "meter_reading_m3": 409,
      "cumulative_meter_reading_m3": 1423.9,
      "meter_index": 3
    },
    {
      "date": "2022-09-01",
      "meter_reading_m3": 416.4,
      "cumulative_meter_reading_m3": 1431.3,
      "meter_index": 3
    },
    {
      "date": "2022-10-01",
      "meter_reading_m3": 423.7,
      "cumulative_meter_reading_m3": 1438.6,
      "meter_index": 3
    },
    {
      "date": "2022-11-01",
      "meter_reading_m3": 432,
      "cumulative_meter_reading_m3": 1446.9,
      "meter_index": 3
    },
    {
      "date": "2022-12-01",
      "meter_reading_m3": 441,
      "cumulative_meter_reading_m3": 1455.9,
      "meter_index": 3
    },
    {
      "date": "2023-01-01",
      "meter_reading_m3": 450,
      "cumulative_meter_reading_m3": 1464.9,
      "meter_index": 3
    },
    {
      "date": "2023-02-01",
      "meter_reading_m3": 459,
      "cumulative_meter_reading_m3": 1473.9,
      "meter_index": 3
    },
    {
      "date": "2023-03-01",
      "meter_reading_m3": 468,
      "cumulative_meter_reading_m3": 1482.9,
      "meter_index": 3
    },
    {
      "date": "2023-04-01",
      "meter_reading_m3": 477,
      "cumulative_meter_reading_m3": 1491.9,
      "meter_index": 3
    },
    {
      "date": "2023-05-01",
      "meter_reading_m3": 486,
      "cumulative_meter_reading_m3": 1500.9,
      "meter_index": 3
    },
    {
      "date": "2023-06-01",
      "meter_reading_m3": 495,
      "cumulative_meter_reading_m3": 1509.9,
      "meter_index": 3
    },
    {
      "date": "2023-07-01",
      "meter_reading_m3": 504,
      "cumulative_meter_reading_m3": 1518.9,
      "meter_index": 3
    },
    {
      "date": "2023-08-01",
      "meter_reading_m3": 513.5,
      "cumulative_meter_reading_m3": 1528.4,
      "meter_index": 3
    },
    {
      "date": "2023-09-01",
      "meter_reading_m3": 524,
      "cumulative_meter_reading_m3": 1538.9,
      "meter_index": 3
    },
    {
      "date": "2023-10-01",
      "meter_reading_m3": 530,
      "cumulative_meter_reading_m3": 1544.9,
      "meter_index": 3
    },
    {
      "date": "2023-11-01",
      "meter_reading_m3": 540,
      "cumulative_meter_reading_m3": 1554.9,
      "meter_index": 3
    },
    {
      "date": "2023-12-01",
      "meter_reading_m3": 548,
      "cumulative_meter_reading_m3": 1562.9,
      "meter_index": 3
    },
    {
      "date": "2024-01-01",
      "meter_reading_m3": 557.1,
      "cumulative_meter_reading_m3": 1572,
      "meter_index": 3
    },
    {
      "date": "2024-02-01",
      "meter_reading_m3": 566.4,
      "cumulative_meter_reading_m3": 1581.3,
      "meter_index": 3
    },
    {
      "date": "2024-03-01",
      "meter_reading_m3": 575,
      "cumulative_meter_reading_m3": 1589.9,
      "meter_index": 3
    },
    {
      "date": "2024-04-01",
      "meter_reading_m3": 583.9,
      "cumulative_meter_reading_m3": 1598.8,
      "meter_index": 3
    },
    {
      "date": "2024-05-01",
      "meter_reading_m3": 5.3,
      "cumulative_meter_reading_m3": 1604.1,
      "meter_index": 4
    },
    {
      "date": "2024-06-01",
      "meter_reading_m3": 14,
      "cumulative_meter_reading_m3": 1612.8,
      "meter_index": 4
    },
    {
      "date": "2024-07-01",
      "meter_reading_m3": 24,
      "cumulative_meter_reading_m3": 1622.8,
      "meter_index": 4
    },
    {
      "date": "2024-08-01",
      "meter_reading_m3": 34,
      "cumulative_meter_reading_m3": 1632.8,
      "meter_index": 4
    },
    {
      "date": "2024-10-01",
      "meter_reading_m3": 45.2,
      "cumulative_meter_reading_m3": 1644,
      "meter_index": 4
    },
    {
      "date": "2024-11-01",
      "meter_reading_m3": 55,
      "cumulative_meter_reading_m3": 1653.8,
      "meter_index": 4
    },
    {
      "date": "2024-12-01",
      "meter_reading_m3": 75,
      "cumulative_meter_reading_m3": 1673.8,
      "meter_index": 4
    },
    {
      "date": "2025-01-01",
      "meter_reading_m3": 84.3,
      "cumulative_meter_reading_m3": 1683.1,
      "meter_index": 4
    },
    {
      "date": "2025-03-01",
      "meter_reading_m3": 97.7,
      "cumulative_meter_reading_m3": 1696.5,
      "meter_index": 4
    },
    {
      "date": "2025-04-01",
      "meter_reading_m3": 105.5,
      "cumulative_meter_reading_m3": 1704.3,
      "meter_index": 4
    },
    {
      "date": "2025-05-01",
      "meter_reading_m3": 115,
      "cumulative_meter_reading_m3": 1713.8,
      "meter_index": 4
    },
    {
      "date": "2025-06-01",
      "meter_reading_m3": 126,
      "cumulative_meter_reading_m3": 1724.8,
      "meter_index": 4
    },
    {
      "date": "2025-07-01",
      "meter_reading_m3": 137.8,
      "cumulative_meter_reading_m3": 1736.6,
      "meter_index": 4
    },
    {
      "date": "2025-08-01",
      "meter_reading_m3": 148,
      "cumulative_meter_reading_m3": 1746.8,
      "meter_index": 4
    },
    {
      "date": "2025-09-01",
      "meter_reading_m3": 156,
      "cumulative_meter_reading_m3": 1754.8,
      "meter_index": 4
    },
    {
      "date": "2025-10-01",
      "meter_reading_m3": 167.9,
      "cumulative_meter_reading_m3": 1766.7,
      "meter_index": 4
    },
    {
      "date": "2025-11-01",
      "meter_reading_m3": 176.3,
      "cumulative_meter_reading_m3": 1775.1,
      "meter_index": 4
    },
    {
      "date": "2026-01-01",
      "meter_reading_m3": 197.3,
      "cumulative_meter_reading_m3": 1796.1,
      "meter_index": 4
    },
    {
      "date": "2026-02-01",
      "meter_reading_m3": 208.05,
      "cumulative_meter_reading_m3": 1806.85,
      "meter_index": 4
    },
    {
      "date": "2026-03-01",
      "meter_reading_m3": 218.8,
      "cumulative_meter_reading_m3": 1817.6,
      "meter_index": 4
    },
    {
      "date": "2026-04-01",
      "meter_reading_m3": 229.2,
      "cumulative_meter_reading_m3": 1828,
      "meter_index": 4
    },
    {
      "date": "2026-05-01",
      "meter_reading_m3": 239.8,
      "cumulative_meter_reading_m3": 1838.6,
      "meter_index": 4
    },
    {
      "date": "2026-06-01",
      "meter_reading_m3": 248,
      "cumulative_meter_reading_m3": 1846.8,
      "meter_index": 4
    },
    {
      "date": "2026-07-01",
      "meter_reading_m3": 257,
      "cumulative_meter_reading_m3": 1855.8,
      "meter_index": 4
    },
    {
      "date": "2026-08-01",
      "meter_reading_m3": 257,
      "cumulative_meter_reading_m3": 1855.8,
      "meter_index": 4
    }
  ]
};
