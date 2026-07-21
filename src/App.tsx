import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Today from './pages/Today';
import PlanTomorrow from './pages/PlanTomorrow';
import Checkpoints from './pages/Checkpoints';
import Report from './pages/Report';
import Setup from './pages/Setup';

function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/plan-tomorrow" element={<PlanTomorrow />} />
        <Route path="/checkpoints" element={<Checkpoints />} />
        <Route path="/report" element={<Report />} />
        <Route path="/setup" element={<Setup />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
