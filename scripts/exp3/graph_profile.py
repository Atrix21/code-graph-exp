#!/usr/bin/env python3
"""
Experiment 3: language-agnostic codebase complexity profile from a built code graph.

Reads a graph built by src/graph/build-cli.ts (graph.sqlite + coverage.json, schema in
src/graph/graph-schema.ts) plus the repository directory, and writes one JSON profile.
Every number is either MEASURED (counted from source or graph) or labelled ESTIMATE.

usage: python -I scripts/exp3/graph_profile.py --name immich --repo <dir> --graph <dir> --out <file.json>
         [--include src] [--seed 20261109] [--sample 400]
Needs networkx (vendor/.venvs/graphify/bin/python has it).
"""
import argparse, collections, json, os, random, re, sqlite3, statistics, sys, time

import networkx as nx
from networkx.algorithms.community import louvain_communities, modularity

TEST_RE = re.compile(r'(\.spec\.|\.test\.|/__tests__/|/test/|/tests/|e2e)')
DECL_TYPES = {'function', 'method', 'class', 'interface', 'type'}
CALLABLE = {'function', 'method'}
# Edge types that a navigating agent can follow between declarations ("navigation graph").
NAV_EDGES = {'CALLS', 'EXTENDS', 'IMPLEMENTS', 'HAS_TYPE', 'REFERENCES', 'INSTANTIATES',
             'INJECTS_DEPENDENCY', 'SERVICE_USES', 'CONTROLLER_CALLS', 'REPOSITORY_ACCESSES',
             'ROUTES_TO', 'PUBLISHES_EVENT', 'CONSUMES_EVENT'}


def q(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


def summary(xs):
    if not xs:
        return {'n': 0}
    return {'n': len(xs), 'mean': round(statistics.fmean(xs), 3), 'p50': q(xs, .5), 'p90': q(xs, .9), 'max': max(xs)}


def source_facts(repo, include):
    out = {'all': collections.Counter(), 'test': collections.Counter()}
    chars = {'all': 0, 'test': 0}
    dirs = set()
    for inc in include:
        for dp, dn, fn in os.walk(os.path.join(repo, inc)):
            dn[:] = [d for d in dn if d not in ('node_modules', 'dist', '.git')]
            for f in fn:
                if not (f.endswith('.ts') or f.endswith('.tsx')) or f.endswith('.d.ts'):
                    continue
                p = os.path.join(dp, f)
                rel = os.path.relpath(p, repo).replace(os.sep, '/')
                txt = open(p, encoding='utf-8', errors='ignore').read()
                k = 'test' if TEST_RE.search('/' + rel) else 'all'
                lines = txt.splitlines()
                out[k]['files'] += 1
                out[k]['lines'] += len(lines)
                out[k]['code_lines'] += sum(1 for l in lines if l.strip() and not l.strip().startswith(('//', '*', '/*')))
                chars[k] += len(txt)
                if k == 'all':
                    dirs.add(os.path.dirname(rel))
    res = {}
    for k in ('all', 'test'):
        res['non_test' if k == 'all' else 'test'] = dict(out[k], chars=chars[k], tokens_estimate_chars_div_4=chars[k] // 4)
    res['source_directories_non_test'] = len(dirs)
    deps = {}
    pj = os.path.join(repo, 'package.json')
    if os.path.exists(pj):
        j = json.load(open(pj))
        deps = {'dependencies': len(j.get('dependencies', {})), 'devDependencies': len(j.get('devDependencies', {}))}
    res['package_json'] = deps
    return res


def component_of(path, src_root, depth):
    """Directory-based module: first `depth` path segments below src_root (or below repo root)."""
    if path is None:
        return None
    parts = path.split('/')
    if parts and parts[0] == src_root:
        parts = parts[1:]
    parts = parts[:-1]  # drop file name
    return '/'.join(parts[:depth]) if parts else '(root)'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--graph', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--include', default='src')
    ap.add_argument('--src-root', default='src')
    ap.add_argument('--seed', type=int, default=20261109)
    ap.add_argument('--sample', type=int, default=400)
    ap.add_argument('--exclude-tests', action='store_true', default=True)
    a = ap.parse_args()
    t0 = time.time()
    rnd = random.Random(a.seed)

    prof = {'name': a.name, 'repo': os.path.relpath(a.repo), 'graph': os.path.relpath(a.graph),
            'generated_by': 'scripts/exp3/graph_profile.py', 'seed': a.seed,
            'definitions': {
                'scope': 'non-test source files only (paths matching *.spec.*, *.test.*, __tests__/, test/, e2e excluded) unless stated',
                'module_dir1': 'first directory segment below src/ (e.g. src/auth -> auth)',
                'module_dir2': 'first two directory segments below src/',
                'community': 'Louvain community (seeded) on the undirected file-level dependency graph (internal imports + navigation edges); architecture-agnostic module boundary',
                'navigation_graph': 'nodes = declared function/method/class/interface/type; edges = ' + ','.join(sorted(NAV_EDGES)) + ' with both endpoints declared in non-test code',
                'tokens_estimate_chars_div_4': 'ESTIMATE: characters / 4 (no tokenizer run)',
            }}
    prof['source'] = source_facts(a.repo, a.include.split(','))

    db = sqlite3.connect(os.path.join(a.graph, 'graph.sqlite'))
    nodes = {}
    for nid, typ, name, qn, f, sl, el, meta in db.execute('select id,type,name,qualified_name,file,start_line,end_line,meta from nodes'):
        nodes[nid] = (typ, name, qn, f, sl, el, meta)
    is_test = lambda f: bool(f) and bool(TEST_RE.search('/' + f))
    keep = lambda nid: nid in nodes and not is_test(nodes[nid][3])

    # ---- full-graph facts (all node and edge types, non-test endpoints)
    ntype = collections.Counter(v[0] for k, v in nodes.items() if not is_test(v[3]))
    etype = collections.Counter(); ever = collections.Counter(); conf = []
    edges = []
    for eid, typ, src, dst, f, line, extraction, c, ver, meta in db.execute(
            'select id,type,src,dst,file,line,extraction,confidence,verification,meta from edges'):
        if is_test(f) or (src in nodes and is_test(nodes[src][3])):
            continue
        etype[typ] += 1; ever[ver] += 1; conf.append(c)
        edges.append((typ, src, dst, f, extraction, c, ver, meta))
    prof['graph_full'] = {
        'nodes': sum(ntype.values()), 'edges': len(edges),
        'nodes_by_type': dict(ntype.most_common()), 'edges_by_type': dict(etype.most_common()),
        'edges_by_verification': dict(ever.most_common()),
        'edge_confidence': {'mean': round(statistics.fmean(conf), 4) if conf else None,
                            'share_ge_0_9': round(sum(1 for x in conf if x >= .9) / len(conf), 4) if conf else None},
    }
    cov_p = os.path.join(a.graph, 'coverage.json')
    if os.path.exists(cov_p):
        cov = json.load(open(cov_p))
        dc = cov.get('detected_calls') or 0
        prof['extraction_coverage'] = {
            'scope': 'all corpus files incl. tests (as built)',
            'files_parsed': f"{cov.get('parsed_files')}/{cov.get('eligible_files')}",
            'detected_calls': dc,
            'resolved_internal_rate': round(cov.get('resolved_calls_internal', 0) / dc, 4) if dc else None,
            'resolved_external_rate': round(cov.get('resolved_calls_external', 0) / dc, 4) if dc else None,
            'unresolved_call_rate': round(cov.get('unresolved_calls', 0) / dc, 4) if dc else None,
            'imports_resolved': f"{cov.get('resolved_imports')}/{cov.get('detected_imports')}",
            'unresolved_import_specifiers': len(cov.get('unresolved_imports', [])),
            'unresolved_references': cov.get('unresolved_references'),
        }

    # ---- size: declarations (non-test)
    decl = {k: v for k, v in nodes.items() if v[0] in DECL_TYPES and not is_test(v[3])}
    dec_counter = collections.Counter(); async_methods = 0; methods = 0; nest_modules = 0
    role = collections.Counter()
    for k, v in nodes.items():
        if is_test(v[3]) or not v[6]:
            continue
        m = json.loads(v[6])
        for d in m.get('decorators', []) or []:
            if isinstance(d, str):
                dec_counter[re.sub(r'\(.*', '', d, flags=re.S).lstrip('@')] += 1
        if v[0] == 'method':
            methods += 1; async_methods += bool(m.get('is_async'))
        if v[0] == 'class':
            if any(isinstance(d, str) and d.lstrip('@').startswith('Module(') for d in m.get('decorators', []) or []):
                nest_modules += 1
            if m.get('role'):
                role[m['role']] += 1
    files_non_test = sorted({v[3] for v in nodes.values() if v[3] and not is_test(v[3]) and v[0] == 'file'})
    prof['size'] = {
        'functions': ntype.get('function', 0), 'methods': ntype.get('method', 0), 'classes': ntype.get('class', 0),
        'interfaces': ntype.get('interface', 0), 'type_aliases_and_enums': ntype.get('type', 0),
        'files_in_graph': len(files_non_test),
        'modules_dir1': len({component_of(f, a.src_root, 1) for f in files_non_test}),
        'modules_dir2': len({component_of(f, a.src_root, 2) for f in files_non_test}),
        'nestjs_module_classes': nest_modules,
        'external_packages_referenced': ntype.get('external_dependency', 0),
        'class_roles': dict(role.most_common()),
    }
    # ---- behavioural indicators (decorators are framework conventions; counted, not interpreted)
    behaviour_decorators = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Query', 'Mutation', 'Resolver', 'Subscription',
                            'OnEvent', 'OnJob', 'Processor', 'Process', 'OnWorkerEvent', 'OnQueueEvent', 'Cron', 'Interval',
                            'Timeout', 'WebSocketGateway', 'SubscribeMessage', 'EventPattern', 'MessagePattern',
                            'OnDatabaseBatchEvent', 'OnCustomBatchEvent', 'InjectRepository', 'InjectKysely', 'Inject',
                            'Entity', 'Injectable', 'Controller', 'Module', 'Command', 'SubCommand']
    prof['behaviour'] = {
        'routes': ntype.get('route', 0),
        'async_method_share': round(async_methods / methods, 4) if methods else None,
        'repository_access_edges': etype.get('REPOSITORY_ACCESSES', 0),
        'database_query_edges': etype.get('QUERIES_DATABASE', 0),
        'external_api_edges': etype.get('CALLS_EXTERNAL_API', 0),
        'event_edges_extracted': {'PUBLISHES_EVENT': etype.get('PUBLISHES_EVENT', 0), 'CONSUMES_EVENT': etype.get('CONSUMES_EVENT', 0)},
        'decorator_counts': {d: dec_counter[d] for d in behaviour_decorators if dec_counter.get(d)},
        'top_decorators': dict(dec_counter.most_common(25)),
    }

    # ---- navigation graph
    G = nx.DiGraph()
    for k, v in decl.items():
        G.add_node(k, t=v[0], f=v[3], name=v[1])
    nav_types = collections.Counter(); call_edges = []
    for typ, src, dst, f, extraction, c, ver, meta in edges:
        if typ in NAV_EDGES and src in decl and dst in decl and src != dst:
            nav_types[typ] += 1
            if G.has_edge(src, dst):
                G[src][dst]['types'].add(typ)
            else:
                G.add_edge(src, dst, types={typ})
            if typ == 'CALLS':
                call_edges.append((src, dst, ver))
    N, E = G.number_of_nodes(), G.number_of_edges()
    U = G.to_undirected()
    comps = sorted((len(c) for c in nx.connected_components(U)), reverse=True)
    deg = [d for _, d in U.degree()]
    indeg = [d for _, d in G.in_degree()]; outdeg = [d for _, d in G.out_degree()]
    mod1 = lambda n: component_of(G.nodes[n]['f'], a.src_root, 1)
    mod2 = lambda n: component_of(G.nodes[n]['f'], a.src_root, 2)
    cross1 = sum(1 for u, v in G.edges() if mod1(u) != mod1(v)); cross2 = sum(1 for u, v in G.edges() if mod2(u) != mod2(v))
    crossfile = sum(1 for u, v in G.edges() if G.nodes[u]['f'] != G.nodes[v]['f'])

    # file-level dependency graph for communities
    F = nx.Graph()
    for f in files_non_test:
        F.add_node(f)
    for typ, src, dst, f, extraction, c, ver, meta in edges:
        if typ == 'IMPORTS' and src in nodes and dst in nodes:
            fs, fd = nodes[src][3], nodes[dst][3]
            if fs and fd and fs != fd and fs in F and fd in F:
                F.add_edge(fs, fd, weight=F[fs][fd]['weight'] + 1 if F.has_edge(fs, fd) else 1)
    for u, v in G.edges():
        fu, fv = G.nodes[u]['f'], G.nodes[v]['f']
        if fu != fv and fu in F and fv in F:
            F.add_edge(fu, fv, weight=F[fu][fv]['weight'] + 1 if F.has_edge(fu, fv) else 1)
    comms = louvain_communities(F, weight='weight', seed=a.seed) if F.number_of_edges() else []
    comm_of = {f: i for i, c in enumerate(comms) for f in c}
    Q = modularity(F, comms, weight='weight') if comms else None
    crossc = sum(1 for u, v in G.edges() if comm_of.get(G.nodes[u]['f']) != comm_of.get(G.nodes[v]['f']))

    # name ambiguity: how many callable declarations share the callee's simple name (what a name grep returns)
    by_name = collections.Counter(v[1] for v in decl.values() if v[0] in CALLABLE)
    amb = [by_name[G.nodes[d]['name']] for s, d, ver in call_edges if G.nodes[d]['t'] in CALLABLE]
    ver_calls = collections.Counter(ver for _, _, ver in call_edges)

    # sampled neighbourhood spread and distances (undirected navigation graph, largest component)
    callables = [n for n in G.nodes if G.nodes[n]['t'] in CALLABLE]
    samp = rnd.sample(callables, min(a.sample, len(callables)))
    files2 = []; mods2 = []; nodes2 = []
    for n in samp:
        reach = nx.single_source_shortest_path_length(U, n, cutoff=2)
        files2.append(len({G.nodes[x]['f'] for x in reach}))
        mods2.append(len({comm_of.get(G.nodes[x]['f']) for x in reach}))
        nodes2.append(len(reach))
    lcc = max(nx.connected_components(U), key=len) if N else set()
    lcc_list = sorted(lcc)
    dists = []
    for _ in range(min(a.sample, 300)):
        if len(lcc_list) < 2:
            break
        s, t = rnd.sample(lcc_list, 2)
        try:
            dists.append(nx.shortest_path_length(U, s, t))
        except nx.NetworkXNoPath:
            pass
    # route-handler reach: how far execution paths go from API entry points (directed CALLS-like edges)
    exec_types = {'CALLS', 'SERVICE_USES', 'CONTROLLER_CALLS', 'REPOSITORY_ACCESSES', 'PUBLISHES_EVENT', 'CONSUMES_EVENT'}
    D = nx.DiGraph([(u, v) for u, v, d in G.edges(data=True) if d['types'] & exec_types])
    handlers = sorted({dst for typ, src, dst, *_ in edges if typ == 'ROUTES_TO' and dst in D})
    hs = rnd.sample(handlers, min(len(handlers), 150))
    depth = []; rfiles = []; rcomms = []
    for h in hs:
        r = nx.single_source_shortest_path_length(D, h)
        depth.append(max(r.values())); rfiles.append(len({G.nodes[x]['f'] for x in r})); rcomms.append(len({comm_of.get(G.nodes[x]['f']) for x in r}))

    prof['navigation_graph'] = {
        'nodes': N, 'edges': E, 'edge_type_instances': dict(nav_types.most_common()),
        'density': round(nx.density(G), 8) if N > 1 else None,
        'degree_undirected': summary(deg), 'in_degree': summary(indeg), 'out_degree': summary(outdeg),
        'connected_components': len(comps), 'largest_component_nodes': comps[0] if comps else 0,
        'largest_component_share': round(comps[0] / N, 4) if N else None,
        'isolated_nodes': sum(1 for x in comps if x == 1),
        'cross_file_edge_ratio': round(crossfile / E, 4) if E else None,
        'cross_module_dir1_edge_ratio': round(cross1 / E, 4) if E else None,
        'cross_module_dir2_edge_ratio': round(cross2 / E, 4) if E else None,
        'cross_community_edge_ratio': round(crossc / E, 4) if E else None,
        'file_graph': {'files': F.number_of_nodes(), 'edges': F.number_of_edges(), 'communities': len(comms),
                       'modularity_Q': round(Q, 4) if Q is not None else None,
                       'community_sizes_top10': sorted((len(c) for c in comms), reverse=True)[:10]},
        'internal_call_edges': len(call_edges),
        'internal_call_verification': dict(ver_calls.most_common()),
        'callee_name_ambiguity': {**summary(amb), 'share_unique_name': round(sum(1 for x in amb if x == 1) / len(amb), 4) if amb else None,
                                  'meaning': 'number of callable declarations sharing the callee simple name, per internal call edge'},
        'two_hop_neighbourhood_sample': {'sampled_callables': len(samp), 'nodes': summary(nodes2), 'files': summary(files2), 'communities': summary(mods2)},
        'lcc_shortest_path_sample': summary(dists),
        'route_handler_reach': {'handlers': len(handlers), 'sampled': len(hs), 'max_depth': summary(depth),
                                'files_reached': summary(rfiles), 'communities_reached': summary(rcomms)},
    }
    prof['elapsed_s'] = round(time.time() - t0, 1)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(prof, open(a.out, 'w'), indent=2)
    print(json.dumps({k: prof[k] for k in ('name', 'size')}, indent=1)[:1500])
    print('wrote', a.out, f'({prof["elapsed_s"]}s)')


if __name__ == '__main__':
    main()
