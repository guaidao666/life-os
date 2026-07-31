import sys, zipfile, re, json
from xml.etree import ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

def main():
    p = sys.argv[1]
    z = zipfile.ZipFile(p)
    names = [n.get('name') for n in ET.fromstring(z.read('xl/workbook.xml')).iter(NS + 'sheet')]
    ss = []
    try:
        r = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in r.findall(NS + 'si'):
            ss.append(''.join(t.text or '' for t in si.iter(NS + 't')))
    except Exception:
        pass

    def cellval(c):
        t = c.get('t'); v = c.find(NS + 'v'); is_ = c.find(NS + 'is')
        if is_ is not None:
            return ''.join(x.text or '' for x in is_.iter(NS + 't'))
        if v is not None:
            if t == 's':
                try:
                    return ss[int(v.text)]
                except Exception:
                    return v.text
            return v.text
        return ''

    out = []
    for i, name in enumerate(names, 1):
        try:
            sx = ET.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'))
        except Exception:
            continue
        rows = []
        for row in sx.iter(NS + 'row'):
            d = {}
            for c in row.findall(NS + 'c'):
                col = re.match(r'[A-Z]+', c.get('r')).group()
                d[col] = cellval(c)
            rows.append(d)
        if not rows:
            out.append({'sheet': name, 'records': []}); continue
        header = rows[0]
        recs = []
        for r in rows[1:]:
            obj = {}
            for col, hname in header.items():
                obj[hname] = r.get(col, '') or ''
            recs.append(obj)
        out.append({'sheet': name, 'records': recs})
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))

if __name__ == '__main__':
    main()
