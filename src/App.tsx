import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Today from './pages/Today';

function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Today />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
