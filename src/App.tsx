import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Today from './pages/Today';
import Plan from './pages/Plan';
import Checkpoints from './pages/Checkpoints';
import Report from './pages/Report';
import Setup from './pages/Setup';
import Habits from './pages/Habits';
import Classes from './pages/Classes';

function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/plan" element={<Plan />} />
        <Route path="/checkpoints" element={<Checkpoints />} />
        <Route path="/report" element={<Report />} />
        <Route path="/habits" element={<Habits />} />
        <Route path="/classes" element={<Classes />} />
        <Route path="/setup" element={<Setup />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
