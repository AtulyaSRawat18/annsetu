"""Dependency-free smoke/integration test for the local demonstrator."""
import json, sys, tempfile, threading, unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import server

class WorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        server.DB=Path(cls.tmp.name)/'workflow.sqlite3'
        server.init()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True); cls.thread.start()
        cls.base='http://127.0.0.1:%d'%cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close(); cls.thread.join(); cls.tmp.cleanup()

    def call(self,path,method='GET',data=None,token=None):
        body=None if data is None else json.dumps(data).encode()
        headers={'Content-Type':'application/json'}
        if token: headers['Authorization']='Bearer '+token
        req=Request(self.base+path,data=body,headers=headers,method=method)
        try:
            with urlopen(req) as response: return response.status,json.loads(response.read())
        except HTTPError as e: return e.code,json.loads(e.read())

    def test_predict_match_approve_deliver(self):
        self.assertEqual(self.call('/api/health')[0],200)
        _,forecast=self.call('/api/forecast','POST',{})
        self.assertEqual(len(forecast['forecasts']),12)
        _,matches=self.call('/api/matches','POST',{})
        match=next(row for row in matches['matches'] if row['product']=='Tomatoes')
        _,proposal=self.call('/api/allocations/propose','POST',{'demand_id':match['demand_id'],'batch_id':match['batch_id'],'quantity':5})
        _,approved=self.call('/api/allocations/approve','POST',{'allocation_id':proposal['allocation_id']})
        self.assertEqual(approved['status'],'approved')
        _,delivery=self.call('/api/deliveries','POST',{'allocation_id':proposal['allocation_id'],'status':'delivered'})
        self.assertEqual(delivery['status'],'delivered')
        _,dashboard=self.call('/api/dashboard')
        self.assertEqual(dashboard['metrics']['delivered_kg'],5)
        self.assertGreater(dashboard['economics']['net_benefit'],0)

if __name__=='__main__': unittest.main(verbosity=2)
