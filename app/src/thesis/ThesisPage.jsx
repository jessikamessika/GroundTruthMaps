const Section = ({ title, children }) => (
  <section className="border-b border-(--line) py-9">
    <h2 className="mb-3.5 font-serif text-2xl leading-tight font-bold">{title}</h2>
    {children}
  </section>
);
const P = ({ children, className = '' }) => <p className={'mb-3.5 max-w-[68ch] ' + className}>{children}</p>;
const caption = 'mt-2 font-sans text-sm leading-normal text-(--muted)';

const STATS = [
  ['21', 'gullies digitized across 8 imagery years (1955–2020); 20 with UAV-derived DEMs'],
  ['4,403 m²/yr', 'areal growth of the Port Burwell gully (Lake Erie), the fastest measured'],
  ['27,669 m³/yr', 'sediment from Port Burwell, about 2% of the regional littoral budget'],
  ['127 m²/yr', 'fastest-growing Lake Huron gully (Gully-15)'],
];

const RESULTS = [
  ['Port Burwell (Erie)', '4,403', '367', '27,669', '1,537'],
  ['Gully-15 (Huron)', '127', '11', '1,287', '71'],
  ['Gully-11 (Huron)', '13', '1', '115', '6'],
  ['Average, all gullies', '40', '3', '413', '23'],
];

function Box({ x, y, w, h = 60, fill, stroke, dash, lines }) {
  const cx = x + w / 2;
  const first = h === 60 ? y + 26 : y + 20;
  return (
    <>
      <rect x={x} y={y} width={w} height={h} fill={fill} stroke={stroke} strokeDasharray={dash} />
      {lines.map((t, i) => <text key={i} x={cx} y={first + i * (h === 60 ? 18 : 17)}>{t}</text>)}
    </>
  );
}

function WorkflowDiagram() {
  const blue = { fill: '#e3ecee', stroke: '#1c7c8c' };
  const tan = { fill: '#efe6d8', stroke: '#8a6f4e' };
  return (
    <svg viewBox="0 0 780 330" role="img" aria-labelledby="wf-t wf-d" className="block h-auto w-full">
      <title id="wf-t">Thesis workflow</title>
      <desc id="wf-d">Historical imagery is digitized into gully areas and ages, producing areal expansion rates. UAV surveys produce DEMs, then sediment volumes, then discharge rates. Both feed an improved sediment budget.</desc>
      <defs>
        <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="#4d6670" />
        </marker>
      </defs>
      <g fill="none" stroke="#4d6670" strokeWidth="1.6" markerEnd="url(#ar)">
        <path d="M150 70H190" /><path d="M340 70H380" /><path d="M530 70H570" />
        <path d="M150 250H190" /><path d="M340 250H380" /><path d="M530 250H570" />
        <path d="M265 100V140" markerEnd="none" />
        <path d="M655 100V150L700 150V150" markerEnd="none" />
        <path d="M655 220V170L700 170" markerEnd="none" />
      </g>
      <g fontSize="13" textAnchor="middle" fill="#12303b">
        <Box x={20} y={40} w={130} {...blue} lines={['Aerial & satellite', 'imagery, 1931–2020']} />
        <Box x={190} y={40} w={150} {...blue} lines={['Manual digitization', 'in ArcGIS Pro']} />
        <Box x={380} y={40} w={150} {...blue} lines={['Gully areas by year', '+ error polygons']} />
        <Box x={570} y={40} w={170} {...blue} lines={['Regression: areal', 'growth + initiation year']} />

        <Box x={190} y={140} w={150} h={50} fill="#ffffff" stroke="#8a6f4e" dash="4 3"
             lines={['Georeference to 2020', 'SWOOP (RMSE)']} />

        <Box x={20} y={220} w={130} {...tan} lines={['RTK-UAV surveys', '+ surveyed GCPs']} />
        <Box x={190} y={220} w={150} {...tan} lines={['DEMs via Structure', 'from Motion (Pix4D)']} />
        <Box x={380} y={220} w={150} {...tan} lines={['Gully volumes', '(ArcGIS Surface Volume)']} />
        <Box x={570} y={220} w={170} {...tan} lines={['Volume ÷ years since', 'initiation = discharge']} />

        <rect x="700" y="135" width="70" height="50" fill="#1c7c8c" />
        <text x="735" y="157" fill="#ffffff">Sediment</text>
        <text x="735" y="173" fill="#ffffff">budget</text>
      </g>
    </svg>
  );
}

export default function ThesisPage() {
  const cell = 'border border-(--line) px-3 py-[9px] text-right first:text-left';
  return (
    <div className="mx-auto max-w-[860px] px-5">
      <header className="border-b border-(--line) pt-14 pb-7">
        <h1 className="mb-3.5 font-serif text-[clamp(30px,6vw,48px)] leading-[1.1] font-bold tracking-[-.01em]">
          Gully Erosion on Lakes Huron and Erie
        </h1>
        <p className="mb-[18px] max-w-[62ch] text-[19px]">
          How fast are coastal gullies growing, and how much sediment do they put into the lake? I answered
          this by combining 90 years of aerial imagery with UAV-built elevation models, and by putting error
          bars on every number.
        </p>
        <p className="font-sans text-[15px] leading-normal text-(--muted)">
          Jess Zhang · B.S. Thesis, Earth Sciences, University of Waterloo · Presented at senior thesis
          poster day · Funded by the Lake Huron Coastal Centre
        </p>
        <div className="mt-[18px] flex flex-wrap gap-3">
          <a href="Poster_Jess_Zhang_pdf_version.pdf"
             className="border-[1.5px] border-(--water) bg-(--water) px-4 py-2.5 font-sans text-[15px] font-semibold text-(--bg) no-underline">
            Read the poster (PDF)
          </a>
        </div>
      </header>

      <Section title="Results at a glance">
        <div className="mt-1.5 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3.5">
          {STATS.map(([big, small]) => (
            <div key={big} className="border border-(--line) bg-(--panel) p-4">
              <b className="block font-serif text-[28px] leading-[1.1] font-bold text-(--water)">{big}</b>
              <span className="font-sans text-sm leading-[1.4] text-(--muted)">{small}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Workflow">
        <P>Two data streams, one set of rates. Historical imagery gives area over time. Fresh drone surveys give volume. Both feed a sediment budget.</P>
        <figure className="mt-[18px] border border-(--line) bg-(--panel) p-3.5">
          <WorkflowDiagram />
          <figcaption className={caption}>
            Blue lane: area from historical imagery. Tan lane: volume from UAV elevation models. Initiation
            years from the area regression set the time base for the volume rates.
          </figcaption>
        </figure>
      </Section>

      <Section title="Method, step by step">
        <ol className="max-w-[68ch] list-decimal pl-[22px] *:mb-3">
          <li><b>Digitize history.</b> I traced gully outlines by hand in ArcGIS Pro for 1955, 1966, 1978, 1980, 2006, 2010, 2015 and 2020, after georeferencing every image to the 2020 SWOOP imagery.</li>
          <li><b>Fit growth rates.</b> A linear fit of area against year (SLOPE in Excel) gave annual areal growth. Projecting the fit back to zero area (INTERCEPT) estimated each gully's initiation year.</li>
          <li><b>Survey by drone.</b> An Autel EVO II V3 RTK flew programmed plan-view surveys at 70 to 80% overlap, 60 m above the bluff, with oblique photos added by hand. White 30 cm GCPs, surveyed with an Emlid Reach RS2, were laid every 10 to 100 m.</li>
          <li><b>Build elevation models.</b> Pix4D Structure from Motion produced DEMs. Gully volumes came from the ArcGIS Surface Volume tool.</li>
          <li><b>Convert to rates.</b> Current volume divided by years since initiation gave average annual sediment discharge. I also expressed results as parking spots and garbage trucks per year so planners could picture them.</li>
        </ol>
      </Section>

      <Section title="Preliminary results">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse bg-(--panel) font-sans text-[15px] leading-[1.4]">
            <thead>
              <tr className="bg-(--soft)">
                {['Gully', 'Area growth (m²/yr)', '≈ parking spots/yr', 'Erosion (m³/yr)', '≈ garbage trucks/yr']
                  .map(h => <th key={h} className={cell}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {RESULTS.map(row => (
                <tr key={row[0]}>{row.map((v, i) => <td key={i} className={cell}>{v}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
        <P className="mt-4">Large gullies grow faster in absolute terms. Relative to their size, small gullies grow faster. Growth is highest early and tapers, so new large gullies deserve the closest monitoring.</P>
      </Section>

      <Section title="How I handled uncertainty">
        <P>Every imagery year has its own positional error, so I combined two sources, following Hapke and Reid (2007). Georeferencing error came from the RMSE against the 2020 reference. Digitization error came from each dataset's resolution and an estimated 1 to 3 pixel user error, larger for finer imagery.</P>
        <P>To turn that into an error on area, I buffered each gully outline outward and inward by the combined uncertainty. The difference between the two polygons is the areal error for that gully and year.</P>
        <P>Limits worth knowing: two remote sites had GPS dropouts and dense canopy, so a DEM there would have mapped vegetation, not ground, and those gullies were studied from imagery only. One gully has since been remediated.</P>
      </Section>

      <footer className="pt-7 pb-14 font-sans text-sm leading-normal text-(--muted)">
        <P>Jess Zhang · jess.jm.zhang@gmail.com · <a href="https://github.com/jessikamessika/GroundTruthMaps" className="text-(--water) underline">Cycling-closure map project</a></P>
        <P>References: Hapke &amp; Reid (2007); O'Rourke et al. (2025), J. Great Lakes Research; Burkard &amp; Kostaschuk (1995), Geomorphology. Full list on the poster.</P>
      </footer>
    </div>
  );
}
